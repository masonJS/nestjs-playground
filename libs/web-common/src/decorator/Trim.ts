import { Transform } from 'class-transformer';

export function Trim() {
  return function (target: any, key: string) {
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim() : value,
    )(target, key);
  };
}
