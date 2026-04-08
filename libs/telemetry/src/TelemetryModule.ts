import { Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from '@nestjs/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { TRACEABLE_METADATA } from './TraceableDecorator';
import { shutdownTelemetry } from './initTelemetry';

@Module({
  imports: [DiscoveryModule],
})
export class TelemetryModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onModuleInit() {
    const tracer = trace.getTracer('nestjs-playground');

    this.getTraceableProviders().forEach((wrapper) => {
      const instance = wrapper.instance;
      if (!instance) {
        return;
      }

      const prototype = Object.getPrototypeOf(instance);
      const methods = this.metadataScanner.getAllMethodNames(prototype);

      methods.forEach((methodName) => {
        if (methodName === 'constructor') {
          return;
        }

        const originalMethod = prototype[methodName];
        if (typeof originalMethod !== 'function') {
          return;
        }

        const spanName = `${wrapper.name}.${methodName}`;

        const wrapped = function (this: unknown, ...args: unknown[]) {
          return tracer.startActiveSpan(spanName, (span) => {
            try {
              const result = originalMethod.apply(this, args) as unknown;

              if (
                result &&
                typeof (result as Promise<unknown>).then === 'function'
              ) {
                return (result as Promise<unknown>).then(
                  (value) => {
                    span.end();
                    return value;
                  },
                  (error) => {
                    span.recordException(error as Error);
                    span.setStatus({ code: SpanStatusCode.ERROR });
                    span.end();
                    throw error;
                  },
                );
              }

              span.end();
              return result;
            } catch (error) {
              span.recordException(error as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.end();
              throw error;
            }
          });
        };

        Reflect.getMetadataKeys(originalMethod).forEach((key: string) => {
          const meta = Reflect.getMetadata(key, originalMethod);
          Reflect.defineMetadata(key, meta, wrapped);
        });

        prototype[methodName] = wrapped;
      });
    });
  }

  async onApplicationShutdown() {
    await shutdownTelemetry();
  }

  private getTraceableProviders() {
    return this.discoveryService
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.metatype &&
          Reflect.hasMetadata(TRACEABLE_METADATA, wrapper.metatype),
      );
  }
}
