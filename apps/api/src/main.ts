import { NestFactory } from '@nestjs/core';
import { ApiModule } from './ApiModule';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  await app.listen(3000);
}

void bootstrap();
