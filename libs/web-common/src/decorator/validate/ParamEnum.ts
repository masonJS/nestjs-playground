import { ValidateEnum } from '../../pipe/ValidateEnum';
import { Param } from '@nestjs/common';

export const ParamEnum = <T>(property: string, enumType: T) =>
  Param(property, new ValidateEnum(enumType));
