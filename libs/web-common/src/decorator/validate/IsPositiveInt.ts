import { IsInt, Max, Min } from 'class-validator';

export function IsPositiveInt(): PropertyDecorator {
  return function (target: any, propertyKey: string | symbol): void {
    IsInt()(target, propertyKey);
    Max(Number.MAX_SAFE_INTEGER)(target, propertyKey);
    Min(1)(target, propertyKey);
  };
}
