import { Param } from '@nestjs/common';
import { ValidateEnum } from '../../pipe/ValidateEnum';

export const ParamEnum = <T>(property: string, enumType: T) =>
  Param(property, new ValidateEnum(enumType));
