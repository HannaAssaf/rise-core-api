import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { SupplierCode } from '@prisma/client';
import {
  FarnellClient,
  SupplierProduct,
} from 'src/suppliers/farnell/farnell.client';
import { Prisma } from '@prisma/client';

function toInputJsonValue(input: unknown): Prisma.InputJsonValue {
  const v = JSON.parse(JSON.stringify(input)) as unknown;
  return (v ?? {}) as Prisma.InputJsonValue;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@Injectable()
export class CatalogSyncJob {
  private readonly logger = new Logger(CatalogSyncJob.name);
  private isRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly farnell: FarnellClient,
    private readonly prisma: PrismaService,
  ) {}

  // ⚠️ For dev: every minute.
  // For prod, usually: '0 */6 * * *' (every 6 hours) or nightly.
  @Cron('*/1 * * * *')
  async run() {
    if (this.isRunning) {
      this.logger.warn('CatalogSync skipped (already running)');
      return;
    }

    this.isRunning = true;

    try {
      const batchSize = toPositiveInt(
        this.config.get('CATALOG_SYNC_BATCH_SIZE'),
        50,
      );

      const term =
        this.config.get<string>('CATALOG_SYNC_FARNELL_TERM') ??
        'any:raspberry pi';

      // How many products we want to fetch in this run (cap).
      const targetTotal = toPositiveInt(
        this.config.get('CATALOG_SYNC_TARGET_TOTAL'),
        150,
      );

      // Guards
      const maxPages = toPositiveInt(
        this.config.get('CATALOG_SYNC_MAX_PAGES'),
        10,
      );
      const maxTotal = toPositiveInt(
        this.config.get('CATALOG_SYNC_MAX_TOTAL'),
        targetTotal,
      );

      const pageSizeDefault = toPositiveInt(
        this.config.get('CATALOG_SYNC_PAGE_SIZE'),
        50,
      );
      const pageDelayMs = toPositiveInt(
        this.config.get('CATALOG_SYNC_PAGE_DELAY_MS'),
        250,
      );
      const batchDelayMs = toPositiveInt(
        this.config.get('CATALOG_SYNC_BATCH_DELAY_MS'),
        100,
      );

      const products: SupplierProduct[] = [];
      const seenSkus = new Set<string>();
      let duplicatePagesInRow = 0;

      const paginationModeEnv = (
        this.config.get<string>('SUPPLIER_FARNELL_PAGINATION_MODE') ?? ''
      )
        .trim()
        .toLowerCase();
      let paginationMode: 'item' | 'page' =
        paginationModeEnv === 'page' ? 'page' : 'item';
      const allowAutoMode = !paginationModeEnv;

      let pageIndex = 0;

      while (products.length < targetTotal) {
        if (pageIndex >= maxPages) {
          this.logger.warn(`Reached maxPages=${maxPages}. Stopping fetch.`);
          break;
        }
        if (products.length >= maxTotal) {
          this.logger.warn(`Reached maxTotal=${maxTotal}. Stopping fetch.`);
          break;
        }

        const remaining = Math.min(targetTotal, maxTotal) - products.length;
        if (remaining <= 0) break;

        const take = Math.min(pageSizeDefault, remaining);
        let offset =
          paginationMode === 'item' ? pageIndex * pageSizeDefault : pageIndex;

        let page = await this.fetchFarnellPageWithRetry({
          term,
          offset,
          take,
          attempts: 3,
        });

        if (
          allowAutoMode &&
          page.length === 0 &&
          paginationMode === 'item' &&
          pageIndex > 0
        ) {
          this.logger.warn(
            `Farnell empty page with item-offset=${offset}. Switching to page-index mode.`,
          );
          paginationMode = 'page';
          offset = pageIndex;
          page = await this.fetchFarnellPageWithRetry({
            term,
            offset,
            take,
            attempts: 3,
          });
        }

        this.logger.log(
          `Fetched pageIndex=${pageIndex} offset=${offset} mode=${paginationMode} got=${page.length} uniqueSkus=${
            new Set(page.map((x) => x.supplierSku)).size
          } first=${page[0]?.supplierSku} last=${page.at(-1)?.supplierSku}`,
        );

        if (page.length === 0) break;

        let added = 0;
        let dupes = 0;
        for (const p of page) {
          if (seenSkus.has(p.supplierSku)) {
            dupes += 1;
            continue;
          }
          seenSkus.add(p.supplierSku);
          products.push(p);
          added += 1;
        }
        const isFullDuplicate = dupes === page.length;

        if (isFullDuplicate) {
          duplicatePagesInRow += 1;
          pageIndex += 1;

          if (duplicatePagesInRow >= 2) {
            this.logger.warn(
              `Farnell duplicate pages in a row=${duplicatePagesInRow}. Stopping pagination.`,
            );
            break;
          }

          continue;
        }

        duplicatePagesInRow = 0;
        pageIndex += 1;

        if (dupes > 0) {
          this.logger.warn(
            `Farnell page duplicates pageIndex=${pageIndex - 1} dupes=${dupes}`,
          );
        }

        this.logger.log(
          `Farnell page added=${added} totalUnique=${products.length}`,
        );

        await new Promise((r) => setTimeout(r, pageDelayMs));
      }

      const batches = chunk(products, batchSize);

      this.logger.log(
        `CatalogSync started. supplier=farnell total=${products.length} batchSize=${batchSize} batches=${batches.length}`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        this.logger.log(
          `Batch ${i + 1}/${batches.length}: ${batch.length} items`,
        );

        const upserted = await this.upsertBatch(batch);

        const first = batch[0]?.supplierSku;
        const last = batch.at(-1)?.supplierSku;
        this.logger.debug(`Upserted: ${upserted} items (${first}..${last})`);

        await new Promise((r) => setTimeout(r, batchDelayMs));
      }

      this.logger.log('CatalogSync finished.');
    } catch (error) {
      this.logger.error('CatalogSync failed', error as Error);
    } finally {
      this.isRunning = false;
    }
  }

  private async fetchFarnellPageWithRetry(args: {
    term: string;
    offset: number;
    take: number;
    attempts?: number;
  }): Promise<SupplierProduct[]> {
    const attempts = args.attempts ?? 3;

    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.farnell.searchProducts({
          term: args.term,
          offset: args.offset,
          numberOfResults: args.take,
          responseGroup: 'large',
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        this.logger.warn(
          `Farnell page failed offset=${args.offset} take=${args.take} attempt=${i}/${attempts}: ${msg}`,
        );

        if (i === attempts) throw e;
        await new Promise((r) => setTimeout(r, 800 * i));
      }
    }

    return [];
  }

  private async upsertBatch(batch: SupplierProduct[]) {
    if (!batch.length) return 0;

    const supplier: SupplierCode = SupplierCode.farnell;

    const ops = batch.map((p) => {
      const supplierKey = `${supplier}:${p.supplierSku}`;

      return this.prisma.product.upsert({
        where: { supplierKey },
        create: {
          supplier,
          supplierSku: p.supplierSku,
          supplierKey,
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
        },
        update: {
          name: p.name,
          raw: toInputJsonValue(p.raw ?? p),
        },
      });
    });

    await this.prisma.$transaction(ops);
    return batch.length;
  }
}
