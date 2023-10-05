import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { DomainException } from '../res/exception/DomainException';

@Injectable()
export class ValidateEnum<T> implements PipeTransform<T> {
  constructor(public readonly enumObj: T) {}

  transform(value: T, { type, data }: ArgumentMetadata): T {
    const enumValues = Object.values(this.enumObj as any);

    if (!enumValues.includes(value)) {
      throw DomainException.BadRequest({
        message: `유효하지 않은 값입니다. [${type}] ${data}=${value}`,
      });
    }

    return value;
  }
}
