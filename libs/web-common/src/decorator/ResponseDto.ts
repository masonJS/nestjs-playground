import { Exclude, Expose } from 'class-transformer';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultMetadataStorage } from 'class-transformer/cjs/storage';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { ApiProperty } from '@nestjs/swagger';

export function ResponseDto() {
  return function (target: any) {
    Exclude()(target.prototype);

    const properties = Object.getOwnPropertyNames(target.prototype);

    properties
      .filter(
        (key) =>
          isGetter(target.prototype, key) &&
          !defaultMetadataStorage.findExposeMetadata(target, key),
      )
      .forEach((key) => Expose()(target.prototype, key));

    properties
      .filter(
        (key) =>
          isGetter(target.prototype, key) &&
          !Reflect.hasMetadata(DECORATORS.API_MODEL_PROPERTIES, target, key),
      )
      .forEach((key) => ApiProperty()(target.prototype, key));
  };

  function isGetter(prototype: any, key: string): boolean {
    return !!Object.getOwnPropertyDescriptor(prototype, key)?.get;
  }
}
