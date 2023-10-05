import { Param, ParseIntPipe } from '@nestjs/common';
import { DomainException } from '../../res/exception/DomainException';

export const ParamInt = (property: string) =>
  Param(
    property,
    new ParseIntPipe({
      exceptionFactory: () =>
        DomainException.BadRequest({
          message: `${property}는 number 형태여야 합니다.`,
        }),
    }),
  );
