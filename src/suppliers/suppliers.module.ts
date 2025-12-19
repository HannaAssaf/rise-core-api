import { Module } from '@nestjs/common';
import { FarnellClient } from './farnell/farnell.client';

@Module({
  providers: [FarnellClient],
  exports: [FarnellClient],
})
export class SuppliersModule {}
