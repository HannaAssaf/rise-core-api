import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type SupplierProduct = {
  supplier: 'farnell';
  supplierSku: string;
  name: string;
};

@Injectable()
export class FarnellClient {
  private readonly logger = new Logger(FarnellClient.name);

  constructor(private readonly config: ConfigService) {}

  // <--change later (now just local)
  async fetchCatalogueMock(total: number): Promise<SupplierProduct[]> {
    // const apiKey = this.config.get<string>('FARNELL_API_KEY');

    this.logger.debug(`fetchCatalogueMock total=${total}`);

    return Array.from({ length: total }).map((_, idx) => ({
      supplier: 'farnell',
      supplierSku: `FARNELL-${String(idx + 1).padStart(6, '0')}`,
      name: `Farnell mock product #${idx + 1}`,
    }));
  }
}
