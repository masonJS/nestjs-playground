import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { VersioningType } from '@nestjs/common/enums/version-type.enum';
import { Logger } from '@app/logger/Logger';
import { GlobalExceptionFilter } from '../../../libs/web-common/src/filter/GlobalExceptionFilter';
import { DomainExceptionFilter } from '../../../libs/web-common/src/filter/DomainExceptionFilter';
import { ClsMiddleware } from '../../../libs/web-common/src/app/ClsMiddleware';

export function setNestApp<T extends INestApplication>(app: T): void {
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(
    new GlobalExceptionFilter(app.get(Logger)),
    new DomainExceptionFilter(app.get(Logger)),
  );
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.use(ClsMiddleware);
}
