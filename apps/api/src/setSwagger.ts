import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';

export function setSwagger<T extends INestApplication>(app: T) {
  const config = new DocumentBuilder()
    .setTitle('Nestjs API')
    .setDescription('Nestjs API 문서')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);
}
