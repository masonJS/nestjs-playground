# Transactional Event Emitter 고도화 설계

## 배경

현재 `@libs/event-emitter`의 `EventEmitterService.raise()`는 호출 즉시 이벤트를 emit한다.
이로 인해 트랜잭션이 롤백되더라도 이벤트 핸들러는 이미 실행된 상태가 되어, **데이터 정합성이 깨질 수 있다.**

예시 시나리오:

```
1. 주문 생성 트랜잭션 시작
2. raise(OrderCreatedEvent)  →  알림 전송 핸들러 즉시 실행
3. 트랜잭션 롤백 (재고 부족)
4. 알림은 이미 전송됨 ← 정합성 불일치
```

## 목표

- 이벤트 발행 시점을 **트랜잭션 Phase**에 바인딩할 수 있도록 확장한다.
- 기존 `raise()` API는 **하위 호환**을 유지한다.
- 현재 프로젝트의 `TransactionService` 패턴(`DataSource.transaction(fn)`)과 자연스럽게 통합한다.

## 현재 구조

```
libs/event-emitter/src/
├── EventEmitterModule.ts        # NestJS 모듈 (EventEmitter2 래핑)
├── EventEmitterService.ts       # raise(event) — 즉시 emit
├── SystemEvent.ts               # 이벤트 추상 클래스
└── decorator/
    └── OnEventLogging.ts        # @OnEventLogging 데코레이터

libs/entity/src/transaction/
└── TransactionService.ts        # DataSource.transaction(fn) 래핑
```

### 현재 TransactionService

```typescript
@Injectable()
export class TransactionService {
  constructor(private dataSource: DataSource) {}

  async transactional<T>(fn: TransactionFunction<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }
}
```

**핵심 제약**: `DataSource.transaction(fn)`은 내부적으로 QueryRunner를 생성하지만,
트랜잭션 lifecycle 콜백(beforeCommit, afterCommit 등)을 직접 노출하지 않는다.
콜백 함수의 인자로 `EntityManager`만 전달되며, 트랜잭션은 함수의 성공/실패로 자동 commit/rollback된다.

```
fn 성공 (resolve) → 자동 commit
fn 실패 (reject)  → 자동 rollback
```

## 설계

### 접근 방식: 이벤트 버퍼링 + TransactionService 확장

QueryRunner의 lifecycle 콜백에 의존하는 대신,
**TransactionService 레벨에서 이벤트를 버퍼링**하고 트랜잭션 결과에 따라 emit한다.

이 방식의 장점:

- 기존 `DataSource.transaction(fn)` 패턴을 그대로 유지
- QueryRunner를 직접 다루지 않아 API가 단순
- 트랜잭션 경계가 명확 (함수 성공 = commit, 실패 = rollback)

### TransactionPhase enum

```typescript
export enum TransactionPhase {
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_COMMIT = 'AFTER_COMMIT',
  AFTER_ROLLBACK = 'AFTER_ROLLBACK',
}
```

### TransactionEventContext

트랜잭션 실행 중 이벤트를 버퍼링하는 컨텍스트 객체.
`TransactionService.transactional(fn)` 콜백에 주입된다.

```typescript
export class TransactionEventContext {
  private readonly buffer = new Map<TransactionPhase, SystemEvent[]>();

  constructor(private readonly eventEmitterService: EventEmitterService) {
    Object.values(TransactionPhase).forEach((phase) =>
      this.buffer.set(phase, []),
    );
  }

  /**
   * 이벤트를 지정된 Phase에 예약한다. 즉시 emit하지 않는다.
   * phase 기본값: AFTER_COMMIT (가장 일반적인 사용 패턴)
   */
  raise(
    event: SystemEvent,
    phase: TransactionPhase = TransactionPhase.AFTER_COMMIT,
  ): void {
    this.buffer.get(phase).push(event);
  }

  /** 지정된 Phase에 버퍼링된 이벤트들을 모두 emit하고 비운다 */
  flush(phase: TransactionPhase): void {
    const events = this.buffer.get(phase);
    events.forEach((event) => this.eventEmitterService.raise(event));
    events.length = 0;
  }

  /** 모든 버퍼를 비운다 (emit하지 않음) */
  clear(): void {
    this.buffer.forEach((events) => (events.length = 0));
  }
}
```

### TransactionService 확장

```typescript
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

  // 기존 API — 하위 호환
  async transactional<T>(fn: TransactionFunction<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }

  // 신규 API — 트랜잭션 Phase에 따라 이벤트 발행
  async transactionalWithEvent<T>(
    fn: TransactionalEventFunction<T>,
  ): Promise<T> {
    const eventContext = new TransactionEventContext(this.eventEmitterService);

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const value = await fn(manager, eventContext);

        // fn 성공 → commit 직전에 BEFORE_COMMIT 이벤트 flush
        eventContext.flush(TransactionPhase.BEFORE_COMMIT);

        return value;
      });

      // commit 성공 → AFTER_COMMIT 이벤트 flush
      eventContext.flush(TransactionPhase.AFTER_COMMIT);

      return result;
    } catch (error) {
      // rollback 발생 → AFTER_ROLLBACK 이벤트 flush
      eventContext.flush(TransactionPhase.AFTER_ROLLBACK);

      throw error;
    } finally {
      // 미처리 이벤트 정리
      eventContext.clear();
    }
  }
}
```

### 실행 흐름

```
transactionalWithEvent(async (manager, eventContext) => {
  // 1. 비즈니스 로직 수행
  await manager.save(order);

  // 2. 이벤트 예약 (아직 emit 안 됨)
  eventContext.raise(new OrderCreatedEvent(order));                           // default: AFTER_COMMIT
  eventContext.raise(new OrderAuditEvent(order), TransactionPhase.BEFORE_COMMIT);
})

─── fn 성공 시 ───────────────────────────────
  → BEFORE_COMMIT flush  (fn 끝, commit 직전)
    → OrderAuditEvent emit
  → DataSource.transaction() commit
  → AFTER_COMMIT flush   (commit 직후)
    → OrderCreatedEvent emit
  → @OnEventLogging 핸들러 실행

─── fn 실패 시 ───────────────────────────────
  → DataSource.transaction() rollback
  → AFTER_ROLLBACK flush (rollback 직후)
  → BEFORE_COMMIT, AFTER_COMMIT 이벤트는 emit되지 않음
```

### 사용 예시

```typescript
// Before: 트랜잭션과 무관하게 즉시 발행
async createOrder(dto: CreateOrderDto) {
  await this.transactionService.transactional(async (manager) => {
    const order = Order.create(dto);
    await manager.save(order);
    this.eventEmitterService.raise(new OrderCreatedEvent(order)); // ⚠️ 롤백되어도 발행됨
  });
}

// After: 커밋 성공 시에만 발행
async createOrder(dto: CreateOrderDto) {
  await this.transactionService.transactionalWithEvent(async (manager, eventContext) => {
    const order = Order.create(dto);
    await manager.save(order);
    eventContext.raise(new OrderCreatedEvent(order)); // ✅ 커밋 성공 시에만 발행
  });
}
```

### 파일 변경 목록

| 작업 | 파일                                                             | 변경 내용                                                          |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 신규 | `libs/event-emitter/src/TransactionPhase.ts`                     | `TransactionPhase` enum                                            |
| 신규 | `libs/event-emitter/src/TransactionEventContext.ts`              | 이벤트 버퍼링 컨텍스트                                             |
| 수정 | `libs/entity/src/transaction/TransactionService.ts`              | `transactionalWithEvent()` 추가, `EventEmitterService` 의존성 추가 |
| 수정 | `libs/event-emitter/test/StubEventEmitterService.ts`             | 필요 시 확장                                                       |
| 신규 | `libs/entity/test/transaction/TransactionalEventEmitter.spec.ts` | 통합 테스트                                                        |

### 모듈 의존성 변경

```
현재:  EntityModule → (TypeORM)
       EventEmitterModule → (EventEmitter2)
       두 모듈은 독립적

변경:  EntityModule → EventEmitterModule (TransactionService가 EventEmitterService를 주입받음)
```

> EntityModule에 EventEmitterModule을 import하거나,
> TransactionService를 별도 모듈로 분리하는 방안도 고려할 수 있다.

## 테스트 계획

### 1. AFTER_COMMIT — 커밋 성공 시 이벤트 발행

```
Given: transactionalWithEvent 내부에서 eventContext.raise(event) 호출
When:  fn이 정상 완료 (commit)
Then:  이벤트 핸들러가 실행됨
```

### 2. AFTER_COMMIT — 롤백 시 이벤트 미발행

```
Given: transactionalWithEvent 내부에서 eventContext.raise(event) 호출
When:  fn이 에러 throw (rollback)
Then:  AFTER_COMMIT 이벤트 핸들러가 실행되지 않음
```

### 3. BEFORE_COMMIT — 커밋 직전 이벤트 발행

```
Given: eventContext.raise(event, BEFORE_COMMIT) 호출
When:  fn이 정상 완료
Then:  이벤트가 commit 전에 발행됨 (fn 내부 마지막에 flush)
```

### 4. AFTER_ROLLBACK — 롤백 시에만 이벤트 발행

```
Given: eventContext.raise(event, AFTER_ROLLBACK) 호출
When:  fn이 에러 throw (rollback)
Then:  AFTER_ROLLBACK 이벤트 핸들러가 실행됨
```

### 5. 기존 transactional — 하위 호환

```
Given: 기존 transactional(fn) 호출
Then:  동작 변경 없음 (이벤트 컨텍스트 없이 기존과 동일)
```

### 6. 복수 이벤트 — Phase별 분리 발행

```
Given: AFTER_COMMIT 이벤트 2개, BEFORE_COMMIT 이벤트 1개 예약
When:  fn 정상 완료
Then:  BEFORE_COMMIT 이벤트 1개 먼저 발행, 이후 AFTER_COMMIT 이벤트 2개 발행
```

## BEFORE_COMMIT 타이밍 정밀도에 대한 참고

`DataSource.transaction(fn)` 내부에서는 fn 반환 직후 commit이 실행된다.
따라서 `BEFORE_COMMIT` flush를 fn의 마지막에 실행하면 **"commit 직전"과 거의 동일한 시점**이지만,
엄밀히 말하면 TypeORM 내부의 commit 호출과 사이에 미세한 간극이 있을 수 있다.

진정한 `beforeTransactionCommit` 정밀도가 필요한 경우,
QueryRunner를 직접 관리하는 별도 메서드를 추가하는 것을 고려할 수 있다. (향후 확장)

## 미지원 / 향후 고려사항

- **이벤트 영속화**: 현재는 인메모리만 지원. 프로세스 재시작 시 미처리 이벤트 유실 가능
- **재시도 메커니즘**: 핸들러 실패 시 재시도 로직은 이 설계 범위 밖
- **분산 환경**: 단일 프로세스 내에서만 동작. 분산 이벤트가 필요하면 Kafka 등 외부 브로커 도입 필요
- **AfterCompletion Phase**: commit/rollback 양쪽 모두에서 실행되는 Phase는 추후 필요 시 추가
- **QueryRunner 직접 관리**: BEFORE_COMMIT의 정밀한 타이밍이 필요한 경우를 위한 확장
