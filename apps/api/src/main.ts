import { NestFactory } from '@nestjs/core';
import { ApiModule } from './ApiModule';
import { setNestApp } from './setNestApp';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);

  setNestApp(app);

  await app.listen(3000);
}

void bootstrap();
