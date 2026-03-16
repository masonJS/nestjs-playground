# Deadlock Victim Selection: PostgreSQL vs MySQL (InnoDB)

## Deadlock 감지 알고리즘

두 DB 모두 **Wait-for Graph (WFG)** 기반으로 deadlock을 감지한다.
트랜잭션 간 lock 대기 관계를 방향 그래프로 구성하고, **cycle(순환)** 이 존재하면 deadlock으로 판단한다.

### PostgreSQL

- **감지 시점**: on-demand (timeout 기반)
- 트랜잭션이 lock 대기를 시작하면 `deadlock_timeout` (기본 1초) 타이머가 시작된다.
- 타이머가 만료되면 그 시점에 Wait-for Graph를 검사한다.
- 상시 감시가 아니므로 오버헤드가 낮다.
- **비활성화 불가** (`deadlock_timeout` 값 조절만 가능)

### MySQL (InnoDB)

- **감지 시점**: 즉시 (lock 요청 시마다)
- lock 요청이 들어올 때마다 Wait-for Graph에서 cycle 존재 여부를 확인한다.
- 높은 동시성 환경에서는 매 요청마다 감지하는 오버헤드가 클 수 있다.
- **비활성화 가능**: `innodb_deadlock_detect = OFF` 로 즉시 감지를 끌 수 있으며, 이 경우 `innodb_lock_wait_timeout` (기본 50초)에 의존

## Victim 선택 기준

### PostgreSQL: 감지 트리거 기반

`deadlock_timeout` 후 deadlock 감지를 **트리거한 트랜잭션**이 victim이 된다.

- 대기를 먼저 시작한 트랜잭션의 타이머가 먼저 만료된다.
- 타이머가 만료된 프로세스가 cycle을 발견하면, **자기 자신을 abort** 한다.
- 트랜잭션이 수행한 작업량(undo log)은 고려하지 않는다.

### MySQL (InnoDB): rollback 비용 기반

undo log가 가장 적은(rollback 비용이 낮은) 트랜잭션이 victim이 된다.

- 트랜잭션의 크기는 INSERT, UPDATE, DELETE한 row 수로 결정된다.
- 적은 작업을 한 트랜잭션을 rollback하여 비용을 최소화한다.
- 대기 시작 시점은 고려하지 않는다.

## 동일 시나리오에서 서로 다른 Victim

```
Tx A: row 1 lock 획득 → 98개 row UPDATE (무거운 작업) → row 2 lock 요청 (대기)
Tx B: row 2 lock 획득 →                               → row 1 lock 요청 (deadlock)
```

| DB | Victim | 이유 |
|---|---|---|
| **PostgreSQL** | **A** | A가 먼저 대기 시작 → `deadlock_timeout` 먼저 도달 → A가 감지 트리거 → A가 abort |
| **MySQL** | **B** | B의 undo log가 적음 → rollback 비용이 낮음 → B가 abort |

동일한 deadlock 상황에서 **정반대의 트랜잭션이 희생**된다.

## 비교 요약

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| **알고리즘** | Wait-for Graph | Wait-for Graph |
| **감지 시점** | timeout 후 on-demand | lock 요청 시 즉시 |
| **기본 대기 시간** | `deadlock_timeout` = 1s | 즉시 (또는 `lock_wait_timeout` = 50s) |
| **victim 선택** | 감지를 트리거한 트랜잭션 | undo log가 가장 적은 트랜잭션 |
| **비활성화** | 불가 | `innodb_deadlock_detect = OFF` |

## 테스트 코드 구현 핵심

### Promise를 이용한 동시 트랜잭션 제어

```typescript
// await 없이 호출 → 쿼리가 DB 서버로 전송되지만 JS는 결과를 기다리지 않음
const promiseA = qrA.query('SELECT ... FOR UPDATE');

// A가 대기 상태에 진입할 시간 확보
await sleep(100);

// B의 lock 요청으로 deadlock cycle 형성
const promiseB = qrB.query('SELECT ... FOR UPDATE');

// 두 Promise의 완료를 동시에 기다림
const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
```

- `await` 없이 `query()`를 호출하면 네트워크 I/O 요청은 libuv로 넘어가 **백그라운드에서 진행**되고, JS 스레드는 즉시 다음 줄로 이동한다.
- `sleep(100)`은 A가 DB 서버의 **lock 대기 큐에 등록**되었음을 보장하기 위한 타이밍 제어다.
- 이 지연이 `deadlock_timeout`보다 짧아야 A의 타이머가 먼저 만료된다 (PostgreSQL 테스트 시 중요).

### 별도 DataSource 사용

- 같은 커넥션에서는 한 번에 하나의 쿼리만 실행할 수 있으므로 deadlock을 재현할 수 없다.
- **2개의 독립된 DataSource**를 생성하여 각각 별도의 TCP 커넥션을 확보해야 한다.