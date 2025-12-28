import { Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { CatalogSyncJob } from './jobs/catalog-sync.job';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly catalogSyncJob: CatalogSyncJob,
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
}
