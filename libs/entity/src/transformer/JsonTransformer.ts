import { ValueTransformer } from 'typeorm/decorator/options/ValueTransformer';
import { FindOperator } from 'typeorm';
import { instanceToPlain, plainToInstance } from 'class-transformer';

type ClassConstructor<T> = {
  new (...args: any[]): T;
};

export class JsonTransformer<T> implements ValueTransformer {
  constructor(readonly classes: ClassConstructor<T>) {}

  from(value: T | FindOperator<any> | null): any {
    if (!value) {
      return {};
    }

    if (value instanceof FindOperator) {
      return value;
    }

    return instanceToPlain(value);
  }

  to(dataBaseValue: Record<string, any>): any {
    return plainToInstance(this.classes, dataBaseValue);
  }
}
