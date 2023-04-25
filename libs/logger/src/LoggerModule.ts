import { Logger } from '@app/logger/Logger';
import { createLogger } from 'winston';
import { getWinstonLoggerOption } from '@app/logger/getWinstonLoggerOption';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
  providers: [
    {
      provide: Logger,
      useFactory: () => createLogger(getWinstonLoggerOption()),
    },
  ],
  exports: [Logger],
})
export class LoggerModule {}
