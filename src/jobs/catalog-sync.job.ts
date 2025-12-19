import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  FarnellClient,
  SupplierProduct,
} from 'src/suppliers/farnell/farnell.client';

function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// type MockProduct = {
//   supplier: 'mock';
//   supplierSku: string;
//   name: string;
// };

@Injectable()
export class CatalogSyncJob {
  private readonly logger = new Logger(CatalogSyncJob.name);
  private isRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly farnell: FarnellClient,
  ) {}

  @Cron('*/10 * * * * *') // <--change later
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
        await this.farnell.fetchCatalogueMock(137); // <--change later
      const batches = chunk(products, batchSize);

      this.logger.log(
        `CatalogSync started. supplier=farnell total=${products.length}, batchSize=${batchSize}, batches=${batches.length}`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        this.logger.log(
          `Batch ${i + 1}/${batches.length}: ${batch.length} items`,
        );
        await this.mockUpsert(batch);
        await new Promise((r) => setTimeout(r, 100)); // <--change later
      }

      this.logger.log('CatalogSync finished.');
    } catch (error) {
      this.logger.error('CatalogSync failed', error as Error);
    } finally {
      this.isRunning = false;
    }
  }

  private async mockUpsert(batch: SupplierProduct[]) {
    const first = batch[0]?.supplierSku;
    const last = batch[batch.length - 1]?.supplierSku;
    this.logger.debug(`Upsert mock: ${batch.length} items (${first}..${last})`);
  }
}

//   private async mockUpsert(batch: MockProduct[]) {
//     // <--change later
//     const first = batch[0]?.supplierSku;
//     const last = batch[batch.length - 1]?.supplierSku;
//     this.logger.debug(`Upsert mock: ${batch.length} items (${first}..${last})`);
//   }
// }
