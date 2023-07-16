import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BuyerFindOneEvent } from '../buyer/event/BuyerFindOneEvent';

@Injectable()
export class NotificationListener {
  @OnEvent(BuyerFindOneEvent.name, { async: true })
  async listen() {
    try {
      throw new Error('event Error');
    } catch (e) {}
  }
}
