import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });
  const port = process.env.PORT || 3030;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}
bootstrap();
