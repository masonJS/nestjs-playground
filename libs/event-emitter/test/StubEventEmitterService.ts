import { EventEmitterService } from '@app/event-emitter/EventEmitterService';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemEvent } from '@app/event-emitter/SystemEvent';

export class StubEventEmitterService extends EventEmitterService {
  private readonly emit = new Map<string, SystemEvent>();

  constructor() {
    super(Object.create(EventEmitter2));
  }

  clear(): this {
    this.emit.clear();

    return this;
  }

  override raise(event: SystemEvent) {
    this.emit.set(event.constructor.name, event);
  }

  get(event: string) {
    return this.emit.get(event);
  }
}
