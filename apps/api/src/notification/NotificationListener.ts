import { Injectable } from '@nestjs/common';
import { BuyerFindOneEvent } from '../buyer/event/BuyerFindOneEvent';
import { OnEventLogging } from '@app/event-emitter/decorator/OnEventLogging';
import { Logger } from '@app/logger/Logger';

@Injectable()
export class NotificationListener {
  constructor(private readonly logger: Logger) {}

  @OnEventLogging(BuyerFindOneEvent.name, { async: true })
  async listen(event: BuyerFindOneEvent) {
    this.logger.info('NotificationListener.listen');
    this.logger.info('event: ' + JSON.stringify(event));
    throw new Error('event Error');
  }
}
