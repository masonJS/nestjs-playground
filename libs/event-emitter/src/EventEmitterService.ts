import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemEvent } from '@app/event-emitter/SystemEvent';

@Injectable()
export class EventEmitterService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  raise(event: SystemEvent) {
    this.eventEmitter.emit(event.constructor.name, event);
  }
}
