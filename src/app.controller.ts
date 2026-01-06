import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { CatalogSyncJob } from './jobs/catalog-sync.job';
import {
  FarnellClient,
  FarnellRateLimitError,
} from './suppliers/farnell/farnell.client';
import { PrismaService } from './prisma/prisma.service';
import { Prisma, SupplierCode } from '@prisma/client';

@Controller()
export class AppController {
  private readonly searchCache = new Map<string, SearchCacheEntry>();

  constructor(
    private readonly appService: AppService,
    private readonly catalogSyncJob: CatalogSyncJob,
    private readonly farnellClient: FarnellClient,
    private readonly prisma: PrismaService,
  ) {}

  // test endpoint
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // manual trigger for Farnell catalog sync
  @Post('/admin/sync/farnell')
  async syncFarnell(): Promise<{ status: 'ok'; message: string }> {
    await this.catalogSyncJob.run();
    return {
      status: 'ok',
      message: 'Farnell catalog sync started',
    };
  }

  @Get('/search')
  async searchCatalog(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('supplier') supplier?: string,
  ): Promise<{
    source: 'local' | 'farnell' | 'empty';
    count: number;
    items: unknown[];
    term?: string;
  }> {
    const query = q?.trim();
    if (!query) return { source: 'empty', count: 0, items: [] };

    const safeLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.floor(Number(limit)))
      : 20;
    const supplierCode = parseSupplierCode(supplier);

    if (supplier && !supplierCode) {
      return { source: 'empty', count: 0, items: [] };
    }

    const cacheKey = buildSearchCacheKey(query, safeLimit, supplierCode);
    const cached = this.getSearchCache(cacheKey);
    if (cached) return cached;

    const localItems = await this.prisma.product.findMany({
      where: {
        OR: [
          { supplierSku: query },
          { name: { contains: query, mode: 'insensitive' } },
        ],
        ...(supplierCode ? { supplier: supplierCode } : {}),
      },
      take: safeLimit,
    });

    if (localItems.length > 0) {
      const result = {
        source: 'local' as const,
        count: localItems.length,
        items: localItems,
      };
      this.setSearchCache(cacheKey, result);
      return result;
    }

    if (supplierCode && supplierCode !== SupplierCode.farnell) {
      return { source: 'empty', count: 0, items: [] };
    }

    const termResolved = buildFarnellTerm({ q: query }) ?? `any:${query}`;
    let items: { supplierSku: string; name: string; raw?: unknown }[] = [];
    let rateLimited = false;

    try {
      items = await this.farnellClient.searchProducts({
        term: termResolved,
        offset: 0,
        numberOfResults: safeLimit,
        responseGroup: 'large',
      });
    } catch (err) {
      if (err instanceof FarnellRateLimitError) {
        rateLimited = true;
      } else {
        throw err;
      }
    }

    if (items.length === 0) {
      const result = {
        source: 'farnell' as const,
        count: 0,
        items: [],
        term: termResolved,
        ...(rateLimited ? { rateLimited: true } : {}),
      };
      this.setSearchCache(cacheKey, result);
      return result;
    }

    const supplierValue = SupplierCode.farnell;
    const ops = items.map((p) => {
      const supplierKey = `${supplierValue}:${p.supplierSku}`;
      return this.prisma.product.upsert({
        where: { supplierKey },
        create: {
          supplier: supplierValue,
          supplierSku: p.supplierSku,
          supplierKey,
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
          sourceUpdatedAt: new Date(),
        },
        update: {
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
          sourceUpdatedAt: new Date(),
        },
      });
    });

    await this.prisma.$transaction(ops);

    const supplierKeys = items.map(
      (p) => `${SupplierCode.farnell}:${p.supplierSku}`,
    );
    const savedItems = await this.prisma.product.findMany({
      where: { supplierKey: { in: supplierKeys } },
      take: safeLimit,
    });

    const result = {
      source: 'farnell' as const,
      count: savedItems.length,
      items: savedItems,
      term: termResolved,
      ...(rateLimited ? { rateLimited: true } : {}),
    };
    this.setSearchCache(cacheKey, result);
    return result;
  }

  @Get('/products')
  async listProducts(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{
    count: number;
    total: number;
    limit: number;
    offset: number;
    items: unknown[];
  }> {
    const safeLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(15, Math.floor(Number(limit))))
      : 15;
    const safeOffset = Number.isFinite(Number(offset))
      ? Math.max(0, Math.floor(Number(offset)))
      : 0;

    const [total, items] = await Promise.all([
      this.prisma.product.count(),
      this.prisma.product.findMany({
        take: safeLimit,
        skip: safeOffset,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      count: items.length,
      total,
      limit: safeLimit,
      offset: safeOffset,
      items,
    };
  }

  @Get('/products/:supplierSku')
  async getProduct(
    @Param('supplierSku') supplierSku: string,
    @Query('refresh') refresh?: string,
  ): Promise<{
    source: 'local' | 'farnell' | 'empty';
    item?: unknown;
    description?: string | null;
    attributes?: Array<{ label: string; value: string; unit?: string }>;
    term?: string;
    rateLimited?: boolean;
  }> {
    const sku = supplierSku?.trim();
    if (!sku) return { source: 'empty' };

    const shouldRefresh = parseBoolean(refresh);
    let item = await this.prisma.product.findFirst({
      where: { supplier: SupplierCode.farnell, supplierSku: sku },
    });

    if (!item || shouldRefresh) {
      const termResolved = buildFarnellTerm({ id: sku }) ?? `id:${sku}`;
      let fetched: { supplierSku: string; name: string; raw?: unknown }[] = [];
      let rateLimited = false;

      try {
        fetched = await this.farnellClient.searchProducts({
          term: termResolved,
          offset: 0,
          numberOfResults: 1,
          responseGroup: 'large',
        });
      } catch (err) {
        if (err instanceof FarnellRateLimitError) {
          rateLimited = true;
        } else {
          throw err;
        }
      }

      if (fetched.length > 0) {
        await this.upsertFarnellProducts(fetched);
        const supplierKey = `${SupplierCode.farnell}:${fetched[0].supplierSku}`;
        item = await this.prisma.product.findUnique({
          where: { supplierKey },
        });
      }

      if (!item) {
        return {
          source: 'empty',
          term: termResolved,
          ...(rateLimited ? { rateLimited: true } : {}),
        };
      }

      return {
        source: 'farnell',
        item,
        description: extractFarnellDescription(item.raw),
        attributes: extractFarnellAttributes(item.raw),
        term: termResolved,
        ...(rateLimited ? { rateLimited: true } : {}),
      };
    }

    return {
      source: 'local',
      item,
      description: extractFarnellDescription(item.raw),
      attributes: extractFarnellAttributes(item.raw),
    };
  }

  @Get('/admin/farnell/search')
  async searchFarnell(
    @Query('term') term?: string,
    @Query('q') q?: string,
    @Query('mpn') mpn?: string,
    @Query('id') id?: string,
    @Query('keyword') keyword?: string,
    @Query('offset') offset?: string,
    @Query('numberOfResults') numberOfResults?: string,
    @Query('responseGroup') responseGroup?: 'small' | 'medium' | 'large',
  ): Promise<{ count: number; items: unknown[]; term: string }> {
    const resolvedTerm =
      buildFarnellTerm({ term, q, mpn, id, keyword }) || 'any:raspberry pi';
    const safeOffset = Number.isFinite(Number(offset))
      ? Math.max(0, Math.floor(Number(offset)))
      : 0;
    const safeNumberOfResults = Number.isFinite(Number(numberOfResults))
      ? Math.max(1, Math.floor(Number(numberOfResults)))
      : 1;

    const items = await this.farnellClient.searchProducts({
      term: resolvedTerm,
      offset: safeOffset,
      numberOfResults: safeNumberOfResults,
      responseGroup: responseGroup ?? 'large',
    });

    return { count: items.length, items, term: resolvedTerm };
  }

  @Post('/admin/farnell/search/batch')
  async searchFarnellBatch(
    @Body() body: unknown,
    @Query('save') save?: string,
  ): Promise<{
    count: number;
    results: Array<{
      input: string;
      term: string;
      count: number;
      items: unknown[];
      error?: string;
    }>;
    savedCount?: number;
    createdCount?: number;
    updatedCount?: number;
  }> {
    const batch = normalizeBatchBody(body);
    const shouldSave = parseBoolean(save);
    const results: Array<{
      input: string;
      term: string;
      count: number;
      items: unknown[];
      error?: string;
    }> = [];
    let savedCount = 0;
    let createdCount = 0;
    let updatedCount = 0;

    for (const query of batch.queries) {
      const termResolved = buildFarnellTerm(query);
      const inputLabel = buildInputLabel(query);

      if (!termResolved) {
        results.push({
          input: inputLabel,
          term: '',
          count: 0,
          items: [],
          error: 'missing query',
        });
        continue;
      }

      const offset = Number.isFinite(Number(query.offset))
        ? Math.max(0, Math.floor(Number(query.offset)))
        : batch.defaults.offset;
      const numberOfResults = Number.isFinite(Number(query.numberOfResults))
        ? Math.max(1, Math.floor(Number(query.numberOfResults)))
        : batch.defaults.numberOfResults;
      const responseGroup = query.responseGroup ?? batch.defaults.responseGroup;

      const items = await this.farnellClient.searchProducts({
        term: termResolved,
        offset,
        numberOfResults,
        responseGroup,
      });

      if (shouldSave && items.length > 0) {
        const saveResult = await this.upsertFarnellProducts(items);
        savedCount += saveResult.total;
        createdCount += saveResult.created;
        updatedCount += saveResult.updated;
      }

      results.push({
        input: inputLabel,
        term: termResolved,
        count: items.length,
        items,
      });
    }

    return {
      count: results.length,
      results,
      savedCount: shouldSave ? savedCount : undefined,
      createdCount: shouldSave ? createdCount : undefined,
      updatedCount: shouldSave ? updatedCount : undefined,
    };
  }

  private getSearchCache(key: string): SearchCatalogResponse | null {
    pruneCache(this.searchCache);
    const entry = this.searchCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.searchCache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setSearchCache(key: string, value: SearchCatalogResponse) {
    const ttlMs = getSearchCacheTtlMs();
    if (ttlMs <= 0) return;
    const expiresAt = Date.now() + ttlMs;
    this.searchCache.set(key, { expiresAt, value });
    pruneCache(this.searchCache);
  }

  private async upsertFarnellProducts(
    items: { supplierSku: string; name: string; raw?: unknown }[],
  ): Promise<{ total: number; created: number; updated: number }> {
    const supplierValue = SupplierCode.farnell;
    const supplierKeys = items.map((p) => `${supplierValue}:${p.supplierSku}`);
    const existing = await this.prisma.product.findMany({
      where: { supplierKey: { in: supplierKeys } },
      select: { supplierKey: true },
    });
    const existingKeys = new Set(existing.map((p) => p.supplierKey));
    const created = supplierKeys.filter((k) => !existingKeys.has(k)).length;
    const updated = supplierKeys.length - created;

    const ops = items.map((p) => {
      const supplierKey = `${supplierValue}:${p.supplierSku}`;
      return this.prisma.product.upsert({
        where: { supplierKey },
        create: {
          supplier: supplierValue,
          supplierSku: p.supplierSku,
          supplierKey,
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
          sourceUpdatedAt: new Date(),
        },
        update: {
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
          sourceUpdatedAt: new Date(),
        },
      });
    });

    await this.prisma.$transaction(ops);
    return { total: items.length, created, updated };
  }
}

type BatchQuery = {
  term?: string;
  q?: string;
  mpn?: string;
  id?: string;
  keyword?: string;
  offset?: number | string;
  numberOfResults?: number | string;
  responseGroup?: ResponseGroup;
};

function normalizeBatchBody(body: unknown): {
  queries: BatchQuery[];
  defaults: {
    offset: number;
    numberOfResults: number;
    responseGroup: ResponseGroup;
  };
} {
  if (Array.isArray(body)) {
    const fallbackResponseGroup: ResponseGroup = 'large';
    return {
      queries: body.map((q) => normalizeBatchQuery(q, fallbackResponseGroup)),
      defaults: {
        offset: 0,
        numberOfResults: 1,
        responseGroup: fallbackResponseGroup,
      },
    };
  }

  const obj = isRecord(body) ? body : {};
  const queriesRaw = Array.isArray(obj.queries) ? obj.queries : [];
  const defaultResponseGroup = parseResponseGroup(obj.responseGroup, 'large');
  const queries = queriesRaw.map((q) =>
    normalizeBatchQuery(q, defaultResponseGroup),
  );

  const defaults = {
    offset: Number.isFinite(Number(obj.offset))
      ? Math.max(0, Math.floor(Number(obj.offset)))
      : 0,
    numberOfResults: Number.isFinite(Number(obj.numberOfResults))
      ? Math.max(1, Math.floor(Number(obj.numberOfResults)))
      : 1,
    responseGroup: defaultResponseGroup,
  };

  if (queries.length > 0) {
    return { queries, defaults };
  }

  return {
    queries: [normalizeBatchQuery(obj, defaultResponseGroup)],
    defaults,
  };
}

type SearchCatalogResponse = {
  source: 'local' | 'farnell' | 'empty';
  count: number;
  items: unknown[];
  term?: string;
  rateLimited?: boolean;
};

type SearchCacheEntry = {
  expiresAt: number;
  value: SearchCatalogResponse;
};

function toInputJsonValue(input: unknown): Prisma.InputJsonValue {
  const v = JSON.parse(JSON.stringify(input)) as unknown;
  return (v ?? {}) as Prisma.InputJsonValue;
}

function buildFarnellTerm(input: {
  term?: string;
  q?: string;
  mpn?: string;
  id?: string;
  keyword?: string;
}): string | null {
  const directTerm = input.term?.trim();
  if (directTerm) return directTerm;

  const mpn = input.mpn?.trim();
  if (mpn) return `manuPartNum:${mpn}`;

  const id = input.id?.trim();
  if (id) return `id:${id}`;

  const keyword = input.keyword?.trim();
  if (keyword) return `any:${keyword}`;

  const q = input.q?.trim();
  if (!q) return null;

  if (/\s/.test(q)) return `any:${q}`;
  if (/^\d+$/.test(q)) return `id:${q}`;

  return `manuPartNum:${q}`;
}

function buildInputLabel(input: BatchQuery): string {
  if (input.term?.trim()) return input.term.trim();
  if (input.mpn?.trim()) return input.mpn.trim();
  if (input.id?.trim()) return input.id.trim();
  if (input.keyword?.trim()) return input.keyword.trim();
  if (input.q?.trim()) return input.q.trim();
  return '';
}

type ResponseGroup = 'small' | 'medium' | 'large';

function parseResponseGroup(
  value: unknown,
  fallback: ResponseGroup,
): ResponseGroup {
  if (value === 'small' || value === 'medium' || value === 'large') {
    return value;
  }
  return fallback;
}

function normalizeBatchQuery(
  input: unknown,
  fallbackResponseGroup: ResponseGroup,
): BatchQuery {
  if (typeof input === 'string') return { q: input };
  if (!isRecord(input)) return {};

  return {
    term: asString(input.term),
    q: asString(input.q),
    mpn: asString(input.mpn),
    id: asString(input.id),
    keyword: asString(input.keyword),
    offset: input.offset as number | string | undefined,
    numberOfResults: input.numberOfResults as number | string | undefined,
    responseGroup: parseResponseGroup(
      input.responseGroup,
      fallbackResponseGroup,
    ),
  };
}

function parseSupplierCode(value?: string): SupplierCode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'farnell') return SupplierCode.farnell;
  if (normalized === 'newark') return SupplierCode.newark;
  if (normalized === 'element14') return SupplierCode.element14;
  if (normalized === 'mock') return SupplierCode.mock;

  return null;
}

function buildSearchCacheKey(
  q: string,
  limit: number,
  supplier: SupplierCode | null,
): string {
  return `${supplier ?? 'any'}|${limit}|${q.toLowerCase()}`;
}

function getSearchCacheTtlMs(): number {
  const raw = process.env.SEARCH_CACHE_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 60_000;
}

function pruneCache(cache: Map<string, SearchCacheEntry>) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  const maxSize = 500;
  if (cache.size <= maxSize) return;

  const deleteCount = cache.size - maxSize;
  let idx = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    idx += 1;
    if (idx >= deleteCount) break;
  }
}

function parseBoolean(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'y'
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function isNotNull<T>(v: T | null): v is T {
  return v !== null;
}

function extractFarnellDescription(raw: unknown): string | null {
  if (!isRecord(raw)) return null;

  const direct =
    asString(raw.longDescription) ??
    asString(raw.shortDescription) ??
    asString(raw.description) ??
    asString(raw.productDescription);
  if (direct) return direct;

  const overview = raw.productOverview;
  if (isRecord(overview)) {
    const fromOverview =
      asString(overview.description) ??
      asString(overview.shortDescription) ??
      asString(overview.longDescription) ??
      asString(overview.alsoKnownAs);
    if (fromOverview) return fromOverview;
  }

  return asString(raw.displayName) ?? asString(raw.name) ?? null;
}

function extractFarnellAttributes(
  raw: unknown,
): Array<{ label: string; value: string; unit?: string }> {
  if (!isRecord(raw)) return [];

  const attrsRaw = raw.attributes;
  const list = Array.isArray(attrsRaw)
    ? attrsRaw
    : isRecord(attrsRaw) && Array.isArray(attrsRaw.attribute)
      ? attrsRaw.attribute
      : [];

  return list
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const label = asString(entry.attributeLabel);
      const value = asString(entry.attributeValue);
      const unit = asString(entry.attributeUnit);
      if (!label || !value) return null;
      return { label, value, ...(unit ? { unit } : {}) };
    })
    .filter(isNotNull);
}
