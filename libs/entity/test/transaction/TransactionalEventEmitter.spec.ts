import { TestingModule } from '@nestjs/testing';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitterModule } from '@app/event-emitter/EventEmitterModule';
import { SystemEvent } from '@app/event-emitter/SystemEvent';
import { TransactionPhase } from '@app/event-emitter/TransactionPhase';
import { TransactionService } from '@app/entity/transaction/TransactionService';
import { InMemoryDBModule } from '../getInMemoryDBModule';

class TestEvent extends SystemEvent {
  constructor(readonly message: string) {
    super();
  }
}

class RollbackTestEvent extends SystemEvent {
  constructor(readonly message: string) {
    super();
  }
}

@Injectable()
class TestEventListener {
  readonly received: SystemEvent[] = [];

  @OnEvent(TestEvent.name)
  onTestEvent(event: TestEvent) {
    this.received.push(event);
  }

  @OnEvent(RollbackTestEvent.name)
  onRollbackTestEvent(event: RollbackTestEvent) {
    this.received.push(event);
  }

  clear() {
    this.received.length = 0;
  }
}

describe('TransactionalEventEmitter', () => {
  let module: TestingModule;
  let transactionService: TransactionService;
  let listener: TestEventListener;

  beforeAll(async () => {
    module = await InMemoryDBModule.connect({
      imports: [EventEmitterModule],
      providers: [TransactionService, TestEventListener],
    });

    await module.init();

    transactionService = module.get(TransactionService);
    listener = module.get(TestEventListener);
  });

  beforeEach(() => {
    listener.clear();
  });

  afterAll(async () => {
    await InMemoryDBModule.disconnect();
  });

  describe('transactionalWithEvent', () => {
    it('AFTER_COMMIT — 커밋 성공 시 이벤트가 발행된다', async () => {
      // when
      await transactionService.transactionalWithEvent(
        async (_manager, eventContext) => {
          eventContext.raise(new TestEvent('committed'));
        },
      );

      // then
      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]).toBeInstanceOf(TestEvent);
      expect((listener.received[0] as TestEvent).message).toBe('committed');
    });

    it('AFTER_COMMIT — 롤백 시 이벤트가 발행되지 않는다', async () => {
      // when
      await expect(
        transactionService.transactionalWithEvent(
          async (_manager, eventContext) => {
            eventContext.raise(new TestEvent('should-not-emit'));
            throw new Error('rollback');
          },
        ),
      ).rejects.toThrow('rollback');

      // then
      const testEvents = listener.received.filter(
        (e) => e instanceof TestEvent,
      );
      expect(testEvents).toHaveLength(0);
    });

    it('BEFORE_COMMIT — 커밋 직전에 이벤트가 발행된다', async () => {
      // when
      await transactionService.transactionalWithEvent(
        async (_manager, eventContext) => {
          eventContext.raise(
            new TestEvent('before-commit'),
            TransactionPhase.BEFORE_COMMIT,
          );
        },
      );

      // then
      expect(listener.received).toHaveLength(1);
      expect((listener.received[0] as TestEvent).message).toBe('before-commit');
    });

    it('AFTER_ROLLBACK — 롤백 시에만 이벤트가 발행된다', async () => {
      // when
      await expect(
        transactionService.transactionalWithEvent(
          async (_manager, eventContext) => {
            eventContext.raise(
              new RollbackTestEvent('rollback-event'),
              TransactionPhase.AFTER_ROLLBACK,
            );
            throw new Error('rollback');
          },
        ),
      ).rejects.toThrow('rollback');

      // then
      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]).toBeInstanceOf(RollbackTestEvent);
      expect((listener.received[0] as RollbackTestEvent).message).toBe(
        'rollback-event',
      );
    });

    it('기존 transactional — 이벤트 컨텍스트 없이 동작한다', async () => {
      // when
      const result = await transactionService.transactional(
        async () => 'hello',
      );

      // then
      expect(result).toBe('hello');
      expect(listener.received).toHaveLength(0);
    });

    it('복수 이벤트 — Phase별로 분리 발행된다', async () => {
      // when
      await transactionService.transactionalWithEvent(
        async (_manager, eventContext) => {
          eventContext.raise(
            new TestEvent('before-1'),
            TransactionPhase.BEFORE_COMMIT,
          );
          eventContext.raise(new TestEvent('after-1'));
          eventContext.raise(new TestEvent('after-2'));
        },
      );

      // then
      expect(listener.received).toHaveLength(3);
      expect((listener.received[0] as TestEvent).message).toBe('before-1');
      expect((listener.received[1] as TestEvent).message).toBe('after-1');
      expect((listener.received[2] as TestEvent).message).toBe('after-2');
    });
  });
});
