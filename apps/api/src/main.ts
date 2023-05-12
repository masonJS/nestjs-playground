import { NestFactory } from '@nestjs/core';
import { ApiModule } from './ApiModule';
import { setNestApp } from './setNestApp';
import { setSwagger } from './setSwagger';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);

  setNestApp(app);
  setSwagger(app);

  app.enableShutdownHooks(); // graceful showdown
  await app.listen(3000);
}

void bootstrap();
