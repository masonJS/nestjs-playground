import { EventEmitterService } from '@app/event-emitter/EventEmitterService';
import { SystemEvent } from '@app/event-emitter/SystemEvent';
import { TransactionPhase } from '@app/event-emitter/TransactionPhase';

export class TransactionEventContext {
  private readonly buffer: Record<TransactionPhase, SystemEvent[]>;

  constructor(private readonly eventEmitterService: EventEmitterService) {
    this.buffer = {
      [TransactionPhase.BEFORE_COMMIT]: [],
      [TransactionPhase.AFTER_COMMIT]: [],
      [TransactionPhase.AFTER_ROLLBACK]: [],
    };
  }

  raise(
    event: SystemEvent,
    phase: TransactionPhase = TransactionPhase.AFTER_COMMIT,
  ): void {
    this.buffer[phase].push(event);
  }

  flush(phase: TransactionPhase): void {
    const events = this.buffer[phase];
    events.forEach((event) => this.eventEmitterService.raise(event));
    events.length = 0;
  }

  clear(): void {
    Object.values(this.buffer).forEach((events) => (events.length = 0));
  }
}
