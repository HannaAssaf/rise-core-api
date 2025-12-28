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

@Injectable()
export class CatalogSyncJob {
  private readonly logger = new Logger(CatalogSyncJob.name);
  private isRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly farnell: FarnellClient,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('*/20 * * * * *') // <-- change later
  async run() {
    if (this.isRunning) {
      this.logger.warn('CatalogSync skipped (already running)');
      return;
    }

    this.isRunning = true;

    try {
      const raw = this.config.get<string>('CATALOG_SYNC_BATCH_SIZE');
      const parsed = Number(raw);
      const batchSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;

      const products: SupplierProduct[] =
        await this.farnell.fetchCatalogueMock(137); // <-- change later
      const batches = chunk(products, batchSize);

      this.logger.log(
        `CatalogSync started. supplier=farnell total=${products.length}, batchSize=${batchSize}, batches=${batches.length}`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        this.logger.log(
          `Batch ${i + 1}/${batches.length}: ${batch.length} items`,
        );

        const upserted = await this.upsertBatch(batch);

        const first = batch[0]?.supplierSku;
        const last = batch[batch.length - 1]?.supplierSku;
        this.logger.debug(`Upserted: ${upserted} items (${first}..${last})`);

        await new Promise((r) => setTimeout(r, 100)); // <-- change later
      }

      this.logger.log('CatalogSync finished.');
    } catch (error) {
      this.logger.error('CatalogSync failed', error as Error);
    } finally {
      this.isRunning = false;
    }
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
          raw: toInputJsonValue(p),
        },
        update: {
          name: p.name,
          raw: toInputJsonValue(p),
        },
      });
    });

    await this.prisma.$transaction(ops);
    return batch.length;
  }
}
