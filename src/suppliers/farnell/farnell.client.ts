import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';

const maybeFetch: unknown = (globalThis as unknown as { fetch?: unknown })
  .fetch;

const fetchFn: typeof fetch =
  typeof maybeFetch === 'function'
    ? (maybeFetch as typeof fetch)
    : (undiciFetch as unknown as typeof fetch);

export type SupplierProduct = {
  supplier: 'farnell';
  supplierSku: string;
  name: string;
  raw?: unknown;
};

export class FarnellRateLimitError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'FarnellRateLimitError';
  }
}

type FarnellSearchOptions = {
  term: string;
  offset?: number;
  numberOfResults?: number;
  responseGroup?: 'small' | 'medium' | 'large';
};

@Injectable()
export class FarnellClient {
  private readonly logger = new Logger(FarnellClient.name);

  constructor(private readonly config: ConfigService) {}

  fetchCatalogueMock(total: number): Promise<SupplierProduct[]> {
    this.logger.debug(`fetchCatalogueMock total=${total}`);
    return Promise.resolve(
      Array.from({ length: total }).map((_, idx) => ({
        supplier: 'farnell',
        supplierSku: `FARNELL-${String(idx + 1).padStart(6, '0')}`,
        name: `Farnell mock product #${idx + 1}`,
      })),
    );
  }

  private mustGet(key: string): string {
    const v = this.config.get<string>(key);
    if (!v) throw new Error(`Missing ${key}`);
    return v;
  }

  private buildBaseUrl(): string {
    return this.mustGet('SUPPLIER_FARNELL_BASE_URL').trim();
  }

  async searchProducts(opts: FarnellSearchOptions): Promise<SupplierProduct[]> {
    const storeId = this.mustGet('SUPPLIER_FARNELL_STORE_ID').trim();
    const apiKey = this.mustGet('SUPPLIER_FARNELL_API_KEY').trim();

    const offset = opts.offset ?? 0;
    const numberOfResults = opts.numberOfResults ?? 50;
    const responseGroup = opts.responseGroup ?? 'large';
    const versionNumberRaw =
      this.config.get<string>('SUPPLIER_FARNELL_VERSION') ?? '1.4';
    const versionNumber = versionNumberRaw.trim();

    const url = new URL(this.buildBaseUrl());

    if (versionNumber) {
      url.searchParams.set('versionNumber', versionNumber);
    }
    url.searchParams.set('term', opts.term);
    url.searchParams.set('storeInfo.id', storeId);

    url.searchParams.set('resultsSettings.offset', String(offset));
    url.searchParams.set(
      'resultsSettings.numberOfResults',
      String(numberOfResults),
    );
    url.searchParams.set('resultsSettings.responseGroup', responseGroup);

    // Optional filter from env
    const filter = (
      this.config.get<string>('SUPPLIER_FARNELL_FILTER') ?? ''
    ).trim();
    if (filter) {
      url.searchParams.set('resultsSettings.refinements.filters', filter);
    }

    url.searchParams.set('callInfo.responseDataFormat', 'json');
    url.searchParams.set('callInfo.omitXmlSchema', 'true');
    url.searchParams.set('callInfo.apiKey', apiKey);

    this.logger.debug(`Farnell GET ${url.toString()}`);

    const json = await this.fetchJsonWithRetry(url.toString());

    const obj = isRecord(json) ? json : null;
    const container =
      (obj && isRecord(obj.keywordSearchReturn) && obj.keywordSearchReturn) ||
      (obj &&
        isRecord(obj.manufacturerPartNumberSearchReturn) &&
        obj.manufacturerPartNumberSearchReturn) ||
      (obj &&
        isRecord(obj.manufacturerPartNumberReturn) &&
        obj.manufacturerPartNumberReturn) ||
      (obj &&
        isRecord(obj.premierFarnellPartNumberReturn) &&
        obj.premierFarnellPartNumberReturn) ||
      obj;

    if (!container || !isRecord(container)) {
      const topKeys = isRecord(json)
        ? Object.keys(json).join(',')
        : typeof json;
      throw new Error(`Farnell: missing container (topLevel=${topKeys})`);
    }

    const productsRaw = container['products'];

    if (productsRaw === undefined) {
      const nor = container['numberOfResults'];

      this.logger.warn(
        `Farnell missing products. offset=${offset} numberOfResults=${numberOfResults} total=${
          typeof nor === 'number' ? nor : JSON.stringify(nor)
        } containerKeys=${Object.keys(container).join(',')}`,
      );

      const extra =
        container['error'] ??
        container['errors'] ??
        container['message'] ??
        container['messages'] ??
        container['fault'] ??
        container['status'];

      this.logger.warn(
        `Farnell missing products extra=${extra ? JSON.stringify(extra).slice(0, 800) : 'n/a'}`,
      );

      this.logger.warn(
        `Farnell missing products container sample: ${JSON.stringify(container).slice(0, 2000)}`,
      );

      return [];
    }

    // Parse products
    let list: unknown[] = [];

    if (Array.isArray(productsRaw)) {
      list = productsRaw;
    } else if (isRecord(productsRaw)) {
      const pv = productsRaw['product'];
      list = Array.isArray(pv) ? pv : pv ? [pv] : [];
    }

    return list
      .map((p): SupplierProduct | null => {
        if (!isRecord(p)) return null;

        const sku = pickString(p, ['sku', 'id', 'productCode']);
        const name = pickString(p, ['displayName', 'name']);

        if (!sku || !name) return null;

        return {
          supplier: 'farnell',
          supplierSku: sku,
          name,
          raw: p,
        };
      })
      .filter(isNotNull);
  }

  private async fetchJsonWithRetry(
    url: string,
    maxAttempts = 5,
  ): Promise<unknown> {
    let attempt = 0;
    let delayMs = 400;

    while (true) {
      attempt++;

      try {
        const res = await fetchFn(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          const waitMs = retryAfter ? Number(retryAfter) * 1000 : delayMs;

          this.logger.warn(
            `Farnell 429 rate-limit. wait=${waitMs}ms attempt=${attempt}/${maxAttempts}`,
          );

          await new Promise((r) => setTimeout(r, waitMs));
          delayMs = Math.min(delayMs * 2, 10_000);

          if (attempt < maxAttempts) continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const lower = text.toLowerCase();
          const isRateLimit403 =
            res.status === 403 &&
            (lower.includes('rate limit') ||
              lower.includes('queries per second'));

          if (isRateLimit403) {
            const waitMs = Math.min(delayMs * 2, 15_000);
            this.logger.warn(
              `Farnell 403 rate-limit. wait=${waitMs}ms attempt=${attempt}/${maxAttempts}`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
            delayMs = Math.min(delayMs * 2, 10_000);

            if (attempt < maxAttempts) continue;

            throw new FarnellRateLimitError(
              `Farnell HTTP ${res.status}. ${text.slice(0, 300)}`,
            );
          }

          throw new Error(`Farnell HTTP ${res.status}. ${text.slice(0, 300)}`);
        }

        return await res.json();
      } catch (e) {
        const err = e as Error;
        this.logger.warn(
          `Farnell request failed attempt=${attempt}/${maxAttempts}: ${err.message}`,
        );

        if (attempt >= maxAttempts) throw err;

        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }
  }
}

// helpers
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function isNotNull<T>(v: T | null): v is T {
  return v !== null;
}
