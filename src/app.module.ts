import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScheduleModule } from '@nestjs/schedule';
import { CatalogSyncJob } from './jobs/catalog-sync.job';
import { ConfigModule } from '@nestjs/config';
import { SuppliersModule } from './suppliers/suppliers.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    SuppliersModule,
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService, CatalogSyncJob],
})
export class AppModule {}
