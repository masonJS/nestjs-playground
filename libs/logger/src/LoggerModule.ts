import { Logger } from '@app/logger/Logger';
import { createLogger } from 'winston';
import { getWinstonLoggerOption } from '@app/logger/getWinstonLoggerOption';
import { Global, Module, OnModuleInit } from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { LOGGING_DECORATOR } from '@app/logger/LoggingDecorator';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    {
      provide: Logger,
      useFactory: () => createLogger(getWinstonLoggerOption()),
    },
  ],
  exports: [Logger],
})
export class LoggerModule implements OnModuleInit {
  constructor(
    private readonly logger: Logger,
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    this.discoveryService
      .getProviders()
      .filter(({ instance }) => instance && Object.getPrototypeOf(instance))
      .forEach(({ instance }) => {
        const prototype = Object.getPrototypeOf(instance);
        const methods = this.metadataScanner.getAllMethodNames(prototype);

        methods.forEach((method) => {
          const loggingMetaData = this.reflector.get(
            LOGGING_DECORATOR,
            instance[method],
          );

          if (!loggingMetaData) {
            return;
          }

          instance[method] = this.wrap(instance, method);
        });
      });
  }

  private wrap(instance: any, method: string) {
    const methodProtoType = instance[method];

    const wrapper = async (...args: any[]) => {
      try {
        return await methodProtoType.apply(instance, args);
      } catch (e) {
        this.logger.error(
          `${instance.constructor.name}.${method}: ${e.message}`,
          e,
        );
      }
    };

    Object.setPrototypeOf(wrapper, methodProtoType);

    return wrapper;
  }
}
