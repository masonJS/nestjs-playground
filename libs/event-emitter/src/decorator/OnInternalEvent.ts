import { applyDecorators, Logger } from '@nestjs/common';
import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { OnEvent } from '@nestjs/event-emitter';

function errorHandler(event: string | symbol | Array<string | symbol>) {
  return function (_target: any, _key: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const metaKeys = Reflect.getOwnMetadataKeys(descriptor.value);
    const originalMetaData = metaKeys.map((key) => [
      key,
      Reflect.getMetadata(key, descriptor.value),
    ]);

    descriptor.value = async function (...args: any[]) {
      try {
        await originalMethod.call(this, ...args);
      } catch (err) {
        Logger.error(
          `event handler error message = ${err.message}, eventName = ${String(
            event,
          )} args = ${JSON.stringify(args)}`,
          err,
        );
      }
    };
    originalMetaData.forEach(([k, v]) =>
      Reflect.defineMetadata(k, v, descriptor.value),
    );
  };
}

export const OnInternalEvent = (
  event: string | symbol | Array<string | symbol>,
  options?: OnEventOptions | undefined,
) =>
  applyDecorators(
    OnEvent(event, options),
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    errorHandler(event),
  );
