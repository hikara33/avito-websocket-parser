import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import express from 'express';
import { join } from 'node:path';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.static(join(process.cwd(), 'src')));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
