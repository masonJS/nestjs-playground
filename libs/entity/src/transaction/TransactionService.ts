import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitterService } from '@app/event-emitter/EventEmitterService';
import { TransactionEventContext } from '@app/event-emitter/TransactionEventContext';
import { TransactionPhase } from '@app/event-emitter/TransactionPhase';

export type TransactionFunction<T = void> = (
  manager: EntityManager,
) => Promise<T>;

export type TransactionalEventFunction<T = void> = (
  manager: EntityManager,
  eventContext: TransactionEventContext,
) => Promise<T>;

@Injectable()
export class TransactionService {
  constructor(
    private dataSource: DataSource,
    private eventEmitterService: EventEmitterService,
  ) {}

  async transactional<T>(fn: TransactionFunction<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }

  async transactionalWithEvent<T>(
    fn: TransactionalEventFunction<T>,
  ): Promise<T> {
    const eventContext = new TransactionEventContext(this.eventEmitterService);

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const value = await fn(manager, eventContext);

        eventContext.flush(TransactionPhase.BEFORE_COMMIT);

        return value;
      });

      eventContext.flush(TransactionPhase.AFTER_COMMIT);

      return result;
    } catch (error) {
      eventContext.flush(TransactionPhase.AFTER_ROLLBACK);

      throw error;
    } finally {
      eventContext.clear();
    }
  }
}
