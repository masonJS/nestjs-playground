import { Injectable, UseInterceptors } from '@nestjs/common';
import { OnEventLogging } from '@app/event-emitter/decorator/OnEventLogging';
import { Logger } from '@app/logger/Logger';
import { OnEvent } from '@nestjs/event-emitter';
import { LoggingInterceptor } from '../../../../libs/web-common/src/interceptor/LoggingInterceptor';
import { BuyerFindOneEvent } from '../buyer/event/BuyerFindOneEvent';

@Injectable()
export class NotificationListener {
  constructor(private readonly logger: Logger) {}

  @OnEventLogging(BuyerFindOneEvent.name, { async: true })
  async listen(event: BuyerFindOneEvent) {
    this.logger.info('NotificationListener.listen');
    this.logger.info('event: ' + JSON.stringify(event));

    throw new Error('event Error listen');
  }

  @OnEvent(BuyerFindOneEvent.name, { async: true })
  @UseInterceptors(LoggingInterceptor)
  async listen2(event: BuyerFindOneEvent) {
    this.logger.info('NotificationListener.listen2');
    this.logger.info('event: ' + JSON.stringify(event));

    throw new Error('event Error listen2');
  }
}
