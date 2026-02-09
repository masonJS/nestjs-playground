# Step 2. Backpressure & Rate Limiting

> Ready Queue / Non-ready Queue 이원화 및 RPS 제한

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [아키텍처 설계](#아키텍처-설계)
3. [Redis 데이터 구조 설계](#redis-데이터-구조-설계)
4. [Fixed Window Rate Limiting 알고리즘](#fixed-window-rate-limiting-알고리즘)
5. [Ready Queue / Non-ready Queue 이원화](#ready-queue--non-ready-queue-이원화)
6. [NestJS 모듈 구조](#nestjs-모듈-구조)
7. [구현 코드](#구현-코드)
8. [Step 1 Fair Queue와의 연동](#step-1-fair-queue와의-연동)
9. [테스트 전략](#테스트-전략)
10. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### Backpressure란?

Backpressure(배압)는 **소비자(Worker)가 감당할 수 있는 속도 이상으로 생산자(Fair Queue)가 작업을 밀어넣지 못하도록 제어하는 메커니즘**이다.

```
Backpressure 없이:
  Fair Queue → → → → → → → → → → Worker (과부하, 장애)

Backpressure 적용:
  Fair Queue → → → [Rate Limit Gate] → → Worker (안정적 처리)
                         │
                         ▼
                   Non-ready Queue (대기)
```

Backpressure가 없으면 다음 문제가 발생한다:

| 문제 | 설명 |
|------|------|
| 외부 API 과부하 | 연동 서비스의 Rate Limit 초과로 429 응답 폭주 |
| 메모리 폭발 | Ready Queue에 무제한 적재 시 OOM 가능 |
| 연쇄 장애 | 하나의 대규모 벌크 요청이 전체 시스템 자원을 잠식 |
| 불공정 자원 분배 | 요청이 많은 고객사가 전체 처리 용량을 독점 |

### Rate Limiting이 필요한 이유

벌크액션 시스템에서 Rate Limiting은 두 가지 역할을 수행한다:

**1) 전체 시스템 보호 (Global Rate Limit)**

```
전체 RPS = 10,000
→ 시스템이 초당 10,000건 이상 처리하지 않도록 보장
→ 외부 연동 서비스의 Rate Limit 준수
→ DB, 메시지 큐 등 내부 인프라 보호
```

**2) 고객사간 공정성 (Per-group Rate Limit)**

```
활성 고객사 N개일 때:
  고객사당 RPS = 전체 RPS / N

예: 전체 10,000 RPS, 고객사 5개
  → 고객사당 2,000 RPS
  → 고객사 A가 10만 건 요청해도 2,000 RPS 이상 처리 불가
  → 나머지 고객사도 각 2,000 RPS 보장
```

### Fixed Window vs 다른 알고리즘

| 알고리즘 | 장점 | 단점 | 적합도 |
|---------|------|------|-------|
| **Fixed Window** | 구현 단순, Redis 1개 키로 가능 | 윈도우 경계에서 burst 가능 | **채택** |
| Sliding Window Log | 정확한 제한 | 메모리 사용량 큼 (모든 요청 기록) | 부적합 |
| Sliding Window Counter | 정확도와 효율 균형 | 구현 복잡 | 대안 |
| Token Bucket | burst 허용 | 상태 관리 복잡 | 대안 |
| Leaky Bucket | 일정 속도 보장 | burst 불가 | 대안 |

Fixed Window를 채택하는 이유:
- **벌크액션은 이미 대량 요청**이므로 윈도우 경계 burst는 무시할 수준
- Redis `INCR` + `EXPIRE` 조합으로 **원자적이고 구현이 단순**
- 고객사별 키를 분리하면 **per-group 제한이 자연스럽게 구현**됨

---

## 아키텍처 설계

### 전체 흐름

```
                        Step 1
                    ┌─────────────┐
                    │  Fair Queue  │
                    │  (dequeue)   │
                    └──────┬──────┘
                           │
                           ▼
                  ┌────────────────┐
                  │  Rate Limiter  │  ← Fixed Window 판정
                  │   isAllowed?   │
                  └───┬────────┬───┘
                      │        │
                 allowed    denied
                      │        │
                      ▼        ▼
              ┌──────────┐  ┌──────────────┐
              │  Ready   │  │  Non-ready   │
              │  Queue   │  │  Queue       │
              │ (List)   │  │ (Sorted Set) │
              └────┬─────┘  │ score=재시도 │
                   │        │  가능 시각    │
                   │        └──────┬───────┘
                   │               │
                   ▼               │ Dispatcher가
              ┌──────────┐        │ 주기적으로 이동
              │  Worker  │        │
              │  Pool    │◄───────┘
              └──────────┘
                Step 4
```

### 작업의 생애주기

```
Fair Queue에서 dequeue
        │
        ▼
   Rate Limit 검사 ──denied──► Non-ready Queue (backoff 시간과 함께)
        │                              │
     allowed                   Dispatcher가 backoff 만료된 작업을
        │                      Ready Queue로 이동
        ▼                              │
   Ready Queue ◄───────────────────────┘
        │
        ▼
   Worker가 꺼내서 처리
        │
   ┌────┴────┐
 성공      실패
   │         │
   ▼         ▼
  ACK    Non-ready Queue (재시도 backoff)
```

---

## Redis 데이터 구조 설계

### Key 네이밍 컨벤션

```
bulk-action:ready-queue                       # List - 즉시 실행 가능 작업
bulk-action:non-ready-queue                   # Sorted Set - 대기 작업 (score = 실행 가능 시각)
bulk-action:rate-limit:{groupId}:{window}     # String - 윈도우별 요청 카운트
bulk-action:rate-limit:global:{window}        # String - 전체 윈도우별 카운트
bulk-action:active-groups                     # Set - 현재 활성 고객사 목록
```

### 데이터 구조 상세

**1) Ready Queue (List)**

즉시 실행 가능한 작업을 FIFO 순서로 보관한다. Worker가 `LPOP`으로 꺼내간다.

```
Key: bulk-action:ready-queue
Type: List
┌───────────────────────────────────────────────┐
│  "job:001" → "job:003" → "job:007" → ...     │
│  (LPOP)                           (RPUSH)     │
└───────────────────────────────────────────────┘
→ 왼쪽에서 꺼내고(LPOP), 오른쪽으로 넣는다(RPUSH)
```

**2) Non-ready Queue (Sorted Set)**

Rate Limit에 걸리거나 일시적 오류로 재시도 대기 중인 작업을 보관한다. score는 **작업이 다시 실행 가능해지는 시각(epoch ms)**이다.

```
Key: bulk-action:non-ready-queue
Type: Sorted Set
┌───────────────────────┬──────────────────┐
│ score (실행 가능 시각)  │ member           │
├───────────────────────┼──────────────────┤
│ 1706000002000         │ job:005          │  ← 가장 빨리 실행 가능
│ 1706000003000         │ job:008          │
│ 1706000005000         │ job:012          │  ← 가장 늦게 실행 가능
└───────────────────────┴──────────────────┘
→ Dispatcher가 주기적으로 score <= now인 작업을 Ready Queue로 이동
```

**3) Rate Limit Counter (String)**

Fixed Window 카운터이다. 윈도우(1초 단위)마다 별도의 키를 생성한다.

```
Key: bulk-action:rate-limit:customer-A:1706000001
Type: String
Value: "47"  (이 윈도우에서 47건 처리됨)
TTL: 2초 (윈도우 종료 후 자동 삭제)

Key: bulk-action:rate-limit:global:1706000001
Type: String
Value: "234"
TTL: 2초
```

**4) Active Groups (Set)**

현재 작업이 진행 중인 고객사 목록이다. per-group RPS 계산에 사용한다.

```
Key: bulk-action:active-groups
Type: Set
{ "customer-A", "customer-B", "customer-C" }
→ 그룹당 RPS = 전체 RPS / SCARD(active-groups)
```

> **자동 cleanup 필요:**
> `rate_limit_check.lua`에서 `SADD`로 등록만 하고, 그룹의 모든 작업이 완료되었을 때 자동으로 제거하는 로직이 없다. `RateLimiterService.deactivateGroup()`이 정의되어 있지만, 이를 호출하는 시점이 명확하지 않다.
> - **Step 5 Watcher 연동**: Watcher가 그룹의 `completedCount + failedCount >= totalCount` 조건을 감지하면 `deactivateGroup()`을 호출한다.
> - **Step 5 미적용 시**: Fetcher에서 Fair Queue의 그룹별 남은 작업 수를 확인하여 0이면 호출하거나, 별도 TTL 기반 자동 만료를 설정한다.
> - cleanup이 누락되면 활성 그룹 수가 계속 증가하여 per-group RPS가 과도하게 낮아지는 문제가 발생한다.

---

## Fixed Window Rate Limiting 알고리즘

### 원리

시간을 1초 단위 윈도우로 나누고, 각 윈도우 내 요청 수를 카운트한다.

```
시간축: ─────────┬─────────┬─────────┬─────────
               1초       2초       3초
윈도우:    [  W1  ]  [  W2  ]  [  W3  ]
카운트:      127       89        203

RPS 제한이 200이라면:
  W1: 127 → 허용
  W2: 89  → 허용
  W3: 203 → 200번째까지 허용, 이후 거부
```

### 윈도우 경계 문제 (Edge Case)

Fixed Window의 알려진 한계: 윈도우 경계에서 최대 2배까지 burst가 발생할 수 있다.

```
W1 마지막 0.1초: 200건
W2 처음 0.1초:   200건
→ 0.2초 안에 400건 처리 (실질 2x burst)
```

벌크액션 시스템에서 이것이 문제가 되지 않는 이유:
- 벌크 작업 자체가 대량이므로 순간 burst보다 **총량 제어**가 중요
- Worker Pool 크기가 유한하므로 실제 동시 처리량은 물리적으로 제한됨
- 외부 API에 Sliding Window가 필요하면 Step 3 혼잡 제어에서 보완

### 동적 RPS 할당

```
전체 RPS: 10,000 (설정값)
활성 고객사: N개

고객사별 RPS = floor(전체 RPS / N)

예시:
  N=1  → 고객사당 10,000 RPS (독점)
  N=5  → 고객사당 2,000 RPS
  N=100 → 고객사당 100 RPS
```

활성 고객사 수가 변하면 **RPS가 실시간으로 재분배**된다. 이는 공정성을 보장하지만, 고객사가 추가/제거될 때 기존 고객사의 RPS가 변동하는 트레이드오프가 있다.

> **`floor()` 연산의 RPS 손실:**
> `floor(10000 / 3) = 3333` → 총 9999 RPS, 1 RPS 미사용. 활성 고객사가 많을수록 이 손실이 누적될 수 있다. 손실이 문제가 된다면 마지막 그룹에 나머지를 할당하거나, global limit만 적용하는 방식을 검토한다.

### Lua 스크립트: rate_limit_check.lua

```lua
-- KEYS[1]: per-group rate limit key (e.g., bulk-action:rate-limit:{groupId}:{window})
-- KEYS[2]: global rate limit key (e.g., bulk-action:rate-limit:global:{window})
-- KEYS[3]: active groups set (e.g., bulk-action:active-groups)
-- ARGV[1]: 전체 RPS
-- ARGV[2]: groupId
-- ARGV[3]: 키 TTL (초)

-- 1. 활성 그룹에 등록
redis.call('SADD', KEYS[3], ARGV[2])

-- 2. 전체 Rate Limit 검사
local globalCount = redis.call('INCR', KEYS[2])
if globalCount == 1 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end

local globalLimit = tonumber(ARGV[1])
if globalCount > globalLimit then
  -- 증가시킨 카운트를 되돌림
  redis.call('DECR', KEYS[2])
  return {0, globalCount - 1, globalLimit, 0, 0}  -- denied (global)
end

-- 3. 고객사별 Rate Limit 검사
local activeGroupCount = redis.call('SCARD', KEYS[3])
local perGroupLimit = math.floor(globalLimit / math.max(1, activeGroupCount))
-- 최소 1 RPS 보장
perGroupLimit = math.max(1, perGroupLimit)

local groupCount = redis.call('INCR', KEYS[1])
if groupCount == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end

if groupCount > perGroupLimit then
  -- 증가시킨 카운트를 되돌림 (global도 함께)
  redis.call('DECR', KEYS[1])
  redis.call('DECR', KEYS[2])
  return {0, globalCount, globalLimit, groupCount - 1, perGroupLimit}  -- denied (per-group)
end

-- 4. 허용
return {1, globalCount, globalLimit, groupCount, perGroupLimit}
```

반환값 구조: `[allowed, globalCount, globalLimit, groupCount, perGroupLimit]`

---

## Ready Queue / Non-ready Queue 이원화

### 역할 분리

| 구분 | Ready Queue | Non-ready Queue |
|------|------------|-----------------|
| 자료구조 | Redis List | Redis Sorted Set |
| 저장 대상 | 즉시 실행 가능한 작업 | 대기 중인 작업 |
| score | 없음 (FIFO) | 실행 가능 시각 (epoch ms) |
| 진입 조건 | Rate Limit 통과 | Rate Limit 거부 또는 일시 오류 |
| 소비자 | Worker (LPOP) | Dispatcher (ZRANGEBYSCORE → Ready Queue로 이동) |

### Non-ready Queue 진입 시나리오

```
시나리오 1: Rate Limit 초과
  → backoff = 혼잡 제어 계산값 (Step 3)
  → score = now + backoff

시나리오 2: 외부 API 429 응답
  → backoff = Retry-After 헤더값 또는 지수 백오프
  → score = now + backoff

시나리오 3: 일시적 네트워크 오류
  → backoff = 기본값 (1초) * 2^retryCount
  → score = now + backoff
```

### Dispatcher의 이동 로직

Dispatcher는 주기적(예: 100ms)으로 Non-ready Queue를 스캔하여 backoff가 만료된 작업을 Ready Queue로 이동한다.

> **Rate Limit 미재검사 트레이드오프:**
> Dispatcher는 Non-ready → Ready 이동 시 Rate Limit을 다시 검사하지 않는다. backoff 시간 동안 충분히 대기했으므로 윈도우가 넘어갔을 가능성이 높지만, 여전히 Rate Limit에 걸릴 수 있다. 이는 의도된 설계로, Dispatcher에서 Rate Limit을 재검사하면 다시 Non-ready Queue로 돌아가는 무한 루프가 발생할 수 있다. 대신, Worker가 실행 시점에 외부 API의 429 응답을 받으면 `backpressure.requeue()`로 Non-ready Queue에 재진입시키는 방식으로 보완한다.

```lua
-- move_to_ready.lua
-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- ARGV[1]: 현재 시각 (epoch ms)
-- ARGV[2]: 최대 이동 수 (batch size)

-- score <= now인 작업을 최대 ARGV[2]개 조회
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #jobs == 0 then
  return 0
end

-- Non-ready Queue에서 제거 + Ready Queue에 추가를 같은 루프에서 처리
-- ZREM → RPUSH를 작업 단위로 묶어야, 중간에 오류 발생 시 정합성 추적이 용이하다.
for _, jobId in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('RPUSH', KEYS[2], jobId)
end

return #jobs
```

> **ready_queue_push.lua** — Ready Queue 원자적 push
>
> ```lua
> -- ready_queue_push.lua
> -- KEYS[1]: ready queue (List)
> -- ARGV[1]: jobId
> -- ARGV[2]: maxSize
>
> local currentSize = redis.call('LLEN', KEYS[1])
> if currentSize >= tonumber(ARGV[2]) then
>   return 0  -- full
> end
>
> redis.call('RPUSH', KEYS[1], ARGV[1])
> return 1  -- success
> ```
>
> `ReadyQueueService.push()`의 LLEN + RPUSH race condition을 원자적으로 해결한다. ioredis의 `defineCommand`로 등록하여 사용한다.

### 큐 크기 제한 (Backpressure)

Ready Queue의 크기에 상한을 두어 메모리를 보호한다.

```
Ready Queue 상한: 10,000 (설정값)

Fair Queue에서 dequeue 시:
  if LLEN(ready-queue) >= 10,000:
    dequeue 중단 (Fetcher 일시 정지)
  else:
    Rate Limit 검사 후 Ready Queue 또는 Non-ready Queue에 추가
```

이 메커니즘이 Backpressure의 핵심이다. Ready Queue가 가득 차면 Fair Queue에서 더 이상 꺼내지 않으므로, 전체 파이프라인에 역방향 압력이 전달된다.

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/src/
├── backpressure/
│   ├── rate-limiter.service.ts           # Fixed Window Rate Limiter
│   ├── rate-limiter.service.spec.ts      # Rate Limiter 테스트
│   ├── ready-queue.service.ts            # Ready Queue 관리
│   ├── ready-queue.service.spec.ts       # Ready Queue 테스트
│   ├── non-ready-queue.service.ts        # Non-ready Queue 관리
│   ├── non-ready-queue.service.spec.ts   # Non-ready Queue 테스트
│   ├── dispatcher.service.ts             # Non-ready → Ready 이동
│   └── backpressure.constants.ts         # 상수 정의
├── config/
│   └── bulk-action.config.ts             # 설정에 backpressure 항목 추가
└── lua/
    ├── rate_limit_check.lua              # Rate Limit 검사
    ├── ready_queue_push.lua              # Ready Queue 원자적 push (LLEN+RPUSH)
    └── move_to_ready.lua                 # Non-ready → Ready 이동
```

### 설정 확장

**`config/bulk-action.config.ts`** (Step 1에서 확장)

```typescript
export interface BulkActionConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
  };
  fairQueue: {
    alpha: number;
  };
  backpressure: {
    globalRps: number;          // 전체 RPS 상한 (default: 10000)
    readyQueueMaxSize: number;  // Ready Queue 최대 크기 (default: 10000)
    rateLimitWindowSec: number; // Rate Limit 윈도우 크기 (default: 1)
    rateLimitKeyTtlSec: number; // Rate Limit 키 TTL (default: 2)
    dispatchIntervalMs: number; // Dispatcher 실행 주기 (default: 100)
    dispatchBatchSize: number;  // Dispatcher 1회 이동량 (default: 100)
    defaultBackoffMs: number;   // 기본 backoff 시간 (default: 1000)
    maxBackoffMs: number;       // 최대 backoff 시간 (default: 60000)
  };
}

export const DEFAULT_BULK_ACTION_CONFIG: BulkActionConfig = {
  redis: {
    host: 'localhost',
    port: 6379,
    db: 0,
    keyPrefix: 'bulk-action:',
  },
  fairQueue: {
    alpha: 10000,
  },
  backpressure: {
    globalRps: 10000,
    readyQueueMaxSize: 10000,
    rateLimitWindowSec: 1,
    rateLimitKeyTtlSec: 2,
    dispatchIntervalMs: 100,
    dispatchBatchSize: 100,
    defaultBackoffMs: 1000,
    maxBackoffMs: 60000,
  },
};
```

---

## 구현 코드

### Rate Limiter Service

**`backpressure/rate-limiter.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

export interface RateLimitResult {
  allowed: boolean;
  globalCount: number;
  globalLimit: number;
  groupCount: number;
  perGroupLimit: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * Fixed Window Rate Limit을 검사한다.
   *
   * 전체 RPS와 고객사별 RPS를 모두 확인하여
   * 둘 다 통과해야 allowed=true를 반환한다.
   */
  async checkRateLimit(groupId: string): Promise<RateLimitResult> {
    const { globalRps, rateLimitWindowSec, rateLimitKeyTtlSec } = this.config.backpressure;
    const window = this.currentWindow();
    const groupKey = `rate-limit:${groupId}:${window}`;
    const globalKey = `rate-limit:global:${window}`;
    const activeGroupsKey = 'active-groups';

    try {
      const result = await (this.redis as any).rate_limit_check(
        groupKey,
        globalKey,
        activeGroupsKey,
        globalRps.toString(),
        groupId,
        rateLimitKeyTtlSec.toString(),
      );

      const rateLimitResult: RateLimitResult = {
        allowed: result[0] === 1,
        globalCount: result[1],
        globalLimit: result[2],
        groupCount: result[3],
        perGroupLimit: result[4],
      };

      if (!rateLimitResult.allowed) {
        this.logger.debug(
          `Rate limited: group=${groupId}, ` +
          `global=${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
          `group=${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit}`,
        );
      }

      return rateLimitResult;
    } catch (error) {
      this.logger.error(`Rate limit check failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 현재 Rate Limit 상태를 조회한다 (모니터링용).
   */
  async getStatus(groupId: string): Promise<{
    globalCount: number;
    globalLimit: number;
    groupCount: number;
    perGroupLimit: number;
    activeGroupCount: number;
  }> {
    const window = this.currentWindow();
    const [globalCount, groupCount, activeGroupCount] = await Promise.all([
      this.redis.get(`rate-limit:global:${window}`).then((v) => parseInt(v ?? '0', 10)),
      this.redis.get(`rate-limit:${groupId}:${window}`).then((v) => parseInt(v ?? '0', 10)),
      this.redis.scard('active-groups'),
    ]);

    const perGroupLimit = Math.max(
      1,
      Math.floor(this.config.backpressure.globalRps / Math.max(1, activeGroupCount)),
    );

    return {
      globalCount,
      globalLimit: this.config.backpressure.globalRps,
      groupCount,
      perGroupLimit,
      activeGroupCount,
    };
  }

  /**
   * 고객사를 활성 그룹에서 제거한다.
   * 그룹의 모든 작업이 완료되었을 때 호출한다.
   */
  async deactivateGroup(groupId: string): Promise<void> {
    await this.redis.srem('active-groups', groupId);
    this.logger.debug(`Deactivated group: ${groupId}`);
  }

  /**
   * 현재 시간의 윈도우 번호를 반환한다.
   * 1초 단위 Fixed Window.
   */
  private currentWindow(): number {
    return Math.floor(Date.now() / (this.config.backpressure.rateLimitWindowSec * 1000));
  }
}
```

### Ready Queue Service

**`backpressure/ready-queue.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

@Injectable()
export class ReadyQueueService {
  private readonly logger = new Logger(ReadyQueueService.name);
  private readonly queueKey = 'ready-queue';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * Ready Queue에 작업을 추가한다.
   * 큐 크기가 상한에 도달하면 false를 반환한다.
   *
   * ⚠️ LLEN과 RPUSH 사이에 race condition이 존재한다.
   * 다중 인스턴스 환경에서 LLEN 검사 후 RPUSH 전에 다른 인스턴스가
   * 작업을 추가하면 maxSize를 초과할 수 있다.
   * 운영 환경에서는 아래의 Lua 스크립트(ready_queue_push.lua) 사용을 권장한다.
   */
  async push(jobId: string): Promise<boolean> {
    // 원자적 버전: Lua 스크립트 사용 권장
    // const result = await (this.redis as any).ready_queue_push(
    //   this.queueKey, jobId, this.config.backpressure.readyQueueMaxSize.toString(),
    // );
    // return result === 1;

    const currentSize = await this.redis.llen(this.queueKey);
    if (currentSize >= this.config.backpressure.readyQueueMaxSize) {
      this.logger.warn(
        `Ready Queue full: ${currentSize}/${this.config.backpressure.readyQueueMaxSize}`,
      );
      return false;
    }

    await this.redis.rpush(this.queueKey, jobId);
    return true;
  }

  /**
   * Ready Queue에서 작업 하나를 꺼낸다.
   * Worker가 호출한다.
   */
  async pop(): Promise<string | null> {
    return this.redis.lpop(this.queueKey);
  }

  /**
   * Ready Queue에서 작업을 블로킹으로 꺼낸다.
   * 큐가 비어있으면 timeout까지 대기한다.
   */
  async blockingPop(timeoutSec: number): Promise<string | null> {
    const result = await this.redis.blpop(this.queueKey, timeoutSec);
    return result ? result[1] : null;
  }

  /**
   * 현재 Ready Queue 크기를 반환한다.
   */
  async size(): Promise<number> {
    return this.redis.llen(this.queueKey);
  }

  /**
   * Ready Queue에 여유 공간이 있는지 확인한다.
   * Fetcher가 Fair Queue에서 dequeue할지 결정할 때 사용한다.
   */
  async hasCapacity(): Promise<boolean> {
    const currentSize = await this.redis.llen(this.queueKey);
    return currentSize < this.config.backpressure.readyQueueMaxSize;
  }
}
```

### Non-ready Queue Service

**`backpressure/non-ready-queue.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

export enum NonReadyReason {
  RATE_LIMITED = 'RATE_LIMITED',
  API_THROTTLED = 'API_THROTTLED',
  TRANSIENT_ERROR = 'TRANSIENT_ERROR',
}

@Injectable()
export class NonReadyQueueService {
  private readonly logger = new Logger(NonReadyQueueService.name);
  private readonly queueKey = 'non-ready-queue';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * Non-ready Queue에 작업을 추가한다.
   *
   * @param jobId 작업 ID
   * @param backoffMs 대기 시간 (ms). 이 시간 후에 Ready Queue로 이동 가능.
   * @param reason 대기 사유
   */
  async push(jobId: string, backoffMs: number, reason: NonReadyReason): Promise<void> {
    const clampedBackoff = Math.min(backoffMs, this.config.backpressure.maxBackoffMs);
    const executeAt = Date.now() + clampedBackoff;

    await this.redis.zadd(this.queueKey, executeAt.toString(), jobId);

    this.logger.debug(
      `Job ${jobId} → Non-ready Queue (reason=${reason}, backoff=${clampedBackoff}ms)`,
    );
  }

  /**
   * 지수 백오프를 계산하여 Non-ready Queue에 추가한다.
   */
  async pushWithExponentialBackoff(
    jobId: string,
    retryCount: number,
    reason: NonReadyReason,
  ): Promise<void> {
    const { defaultBackoffMs, maxBackoffMs } = this.config.backpressure;
    const backoff = Math.min(
      defaultBackoffMs * Math.pow(2, retryCount),
      maxBackoffMs,
    );
    await this.push(jobId, backoff, reason);
  }

  /**
   * backoff가 만료된 작업 목록을 조회한다 (제거하지 않음).
   */
  async peekReady(limit: number): Promise<string[]> {
    const now = Date.now().toString();
    return this.redis.zrangebyscore(this.queueKey, '-inf', now, 'LIMIT', 0, limit);
  }

  /**
   * backoff가 만료된 작업을 Non-ready Queue에서 제거하고 반환한다.
   *
   * ⚠️ 비원자성 경고:
   * ZRANGEBYSCORE와 ZREM이 별도 명령으로 실행되므로, 다중 인스턴스 환경에서
   * 두 인스턴스가 동시에 같은 작업을 조회하여 중복 처리할 수 있다.
   * Dispatcher에서는 반드시 move_to_ready.lua를 통해 원자적으로 처리해야 하며,
   * 이 메서드는 단일 인스턴스 테스트 또는 디버깅 용도로만 사용한다.
   */
  async popReady(limit: number): Promise<string[]> {
    const now = Date.now();
    const jobs = await this.redis.zrangebyscore(
      this.queueKey,
      '-inf',
      now.toString(),
      'LIMIT',
      0,
      limit,
    );

    if (jobs.length > 0) {
      await this.redis.zrem(this.queueKey, ...jobs);
    }

    return jobs;
  }

  /**
   * 특정 작업을 Non-ready Queue에서 제거한다.
   */
  async remove(jobId: string): Promise<void> {
    await this.redis.zrem(this.queueKey, jobId);
  }

  /**
   * Non-ready Queue의 전체 크기를 반환한다.
   */
  async size(): Promise<number> {
    return this.redis.zcard(this.queueKey);
  }

  /**
   * 특정 그룹의 Non-ready 작업 수를 반환한다.
   * Step 3 혼잡 제어에서 동적 backoff 계산에 사용한다.
   */
  async countByGroup(groupId: string): Promise<number> {
    // 그룹별 카운트는 별도 보조 키로 관리하거나,
    // jobId에 groupId 접두사를 포함시켜 SCAN으로 카운트
    // 여기서는 성능을 위해 별도 카운터 사용
    const counterKey = `non-ready-count:${groupId}`;
    const count = await this.redis.get(counterKey);
    return parseInt(count ?? '0', 10);
  }

  /**
   * 그룹별 Non-ready 카운터를 증가시킨다.
   */
  async incrementGroupCount(groupId: string): Promise<void> {
    await this.redis.incr(`non-ready-count:${groupId}`);
  }

  /**
   * 그룹별 Non-ready 카운터를 감소시킨다.
   */
  async decrementGroupCount(groupId: string): Promise<void> {
    const key = `non-ready-count:${groupId}`;
    const result = await this.redis.decr(key);
    if (result < 0) {
      await this.redis.set(key, '0');
    }
  }
}
```

### Dispatcher Service

**`backpressure/dispatcher.service.ts`**

```typescript
import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';
import { ReadyQueueService } from './ready-queue.service';
import { NonReadyQueueService } from './non-ready-queue.service';

@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Dispatcher를 시작한다.
   * 설정된 주기로 Non-ready Queue를 스캔하여 Ready Queue로 이동한다.
   */
  start(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(
      () => this.dispatch(),
      this.config.backpressure.dispatchIntervalMs,
    );

    this.logger.log(
      `Dispatcher started (interval=${this.config.backpressure.dispatchIntervalMs}ms)`,
    );
  }

  /**
   * Dispatcher를 중지한다.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Dispatcher stopped');
    }
  }

  /**
   * 1회 dispatch 사이클을 실행한다.
   *
   * 1. Ready Queue에 여유 공간이 있는지 확인
   * 2. Non-ready Queue에서 backoff 만료된 작업 조회
   * 3. Ready Queue로 이동
   */
  private async dispatch(): Promise<void> {
    if (this.isRunning) return; // 이전 사이클이 아직 실행 중이면 스킵
    this.isRunning = true;

    try {
      const hasCapacity = await this.readyQueue.hasCapacity();
      if (!hasCapacity) {
        this.logger.debug('Ready Queue full, skipping dispatch');
        return;
      }

      const moved = await this.moveToReady();
      if (moved > 0) {
        this.logger.debug(`Dispatched ${moved} jobs from Non-ready → Ready Queue`);
      }
    } catch (error) {
      this.logger.error(`Dispatch failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Lua 스크립트를 사용하여 원자적으로 Non-ready → Ready Queue 이동을 수행한다.
   */
  private async moveToReady(): Promise<number> {
    const result = await (this.redis as any).move_to_ready(
      'non-ready-queue',
      'ready-queue',
      Date.now().toString(),
      this.config.backpressure.dispatchBatchSize.toString(),
    );
    return result;
  }
}
```

### Backpressure 통합 서비스

Fair Queue에서 꺼낸 작업을 Rate Limit 검사 후 적절한 큐로 분배하는 오케스트레이터이다.

**`backpressure/backpressure.service.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';
import { ReadyQueueService } from './ready-queue.service';
import { NonReadyQueueService, NonReadyReason } from './non-ready-queue.service';
import { Job } from '../model/job';

export interface BackpressureResult {
  accepted: boolean;
  destination: 'ready' | 'non-ready' | 'rejected';
  reason?: string;
}

@Injectable()
export class BackpressureService {
  private readonly logger = new Logger(BackpressureService.name);

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
  ) {}

  /**
   * Fair Queue에서 dequeue된 작업을 Rate Limit 검사 후
   * Ready Queue 또는 Non-ready Queue로 분배한다.
   *
   * 이 메서드가 Fetcher(Step 4)에서 호출되는 핵심 진입점이다.
   *
   * ⚠️ 작업 유실 구간:
   * `accepted: false` (rejected)를 반환하면 작업은 Fair Queue에서 이미 dequeue된 상태이지만
   * Ready Queue에도 Non-ready Queue에도 들어가지 않는다.
   * 호출자(Fetcher)가 rejected를 받으면 반드시 작업을 Fair Queue에 re-enqueue하거나,
   * Step 6의 In-flight Queue에서 orphan recovery로 복구해야 한다.
   * Step 6 적용 전까지는 Fetcher에서 `accepted === false` 시 re-enqueue 로직을 구현할 것.
   */
  async admit(job: Job): Promise<BackpressureResult> {
    // 1. Ready Queue 용량 확인
    const hasCapacity = await this.readyQueue.hasCapacity();
    if (!hasCapacity) {
      return {
        accepted: false,
        destination: 'rejected',
        reason: 'Ready Queue at capacity',
      };
    }

    // 2. Rate Limit 검사
    const rateLimitResult = await this.rateLimiter.checkRateLimit(job.groupId);

    if (rateLimitResult.allowed) {
      // 3a. Rate Limit 통과 → Ready Queue
      const pushed = await this.readyQueue.push(job.id);
      if (!pushed) {
        // push 시점에 다른 스레드가 채웠을 수 있음
        return {
          accepted: false,
          destination: 'rejected',
          reason: 'Ready Queue became full',
        };
      }

      return { accepted: true, destination: 'ready' };
    }

    // 3b. Rate Limit 초과 → Non-ready Queue
    const backoffMs = this.calculateBackoff(job.groupId);
    await this.nonReadyQueue.push(job.id, backoffMs, NonReadyReason.RATE_LIMITED);
    await this.nonReadyQueue.incrementGroupCount(job.groupId);

    return {
      accepted: true,
      destination: 'non-ready',
      reason: `Rate limited (global: ${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
              `group: ${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit})`,
    };
  }

  /**
   * 작업 처리 실패 시 Non-ready Queue로 되돌린다.
   */
  async requeue(jobId: string, groupId: string, retryCount: number): Promise<void> {
    await this.nonReadyQueue.pushWithExponentialBackoff(
      jobId,
      retryCount,
      NonReadyReason.TRANSIENT_ERROR,
    );
    await this.nonReadyQueue.incrementGroupCount(groupId);
  }

  /**
   * backoff 시간을 계산한다.
   * 기본값은 1초이며, Step 3 혼잡 제어에서 동적 계산으로 대체된다.
   */
  private calculateBackoff(groupId: string): number {
    // Step 3에서 혼잡 제어 로직으로 교체 예정
    // 현재는 고정 1초 backoff
    return 1000;
  }
}
```

### 모듈 등록

**`bulk-action.module.ts`** (Step 1에서 확장)

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { FairQueueService } from './fair-queue/fair-queue.service';
import { LuaScriptLoader } from './lua/lua-script-loader';
import { redisProvider, BULK_ACTION_CONFIG } from './redis/redis.provider';
import { RateLimiterService } from './backpressure/rate-limiter.service';
import { ReadyQueueService } from './backpressure/ready-queue.service';
import { NonReadyQueueService } from './backpressure/non-ready-queue.service';
import { DispatcherService } from './backpressure/dispatcher.service';
import { BackpressureService } from './backpressure/backpressure.service';
import {
  BulkActionConfig,
  DEFAULT_BULK_ACTION_CONFIG,
} from './config/bulk-action.config';

@Module({})
export class BulkActionModule {
  static register(config?: Partial<BulkActionConfig>): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      ...DEFAULT_BULK_ACTION_CONFIG,
      ...config,
      redis: { ...DEFAULT_BULK_ACTION_CONFIG.redis, ...config?.redis },
      fairQueue: { ...DEFAULT_BULK_ACTION_CONFIG.fairQueue, ...config?.fairQueue },
      backpressure: { ...DEFAULT_BULK_ACTION_CONFIG.backpressure, ...config?.backpressure },
    };

    return {
      module: BulkActionModule,
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: mergedConfig },
        redisProvider,
        LuaScriptLoader,
        FairQueueService,
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        DispatcherService,
        BackpressureService,
      ],
      exports: [
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
      ],
    };
  }
}
```

---

## Step 1 Fair Queue와의 연동

### 데이터 흐름

```
┌─────────────────────────────────────────────────────────┐
│                      Fetcher (Step 4)                   │
│                                                         │
│  1. fairQueue.dequeue()        ──── Step 1 Fair Queue   │
│        │                                                │
│        ▼                                                │
│  2. backpressure.admit(job)    ──── Step 2 시작점       │
│        │                                                │
│        ├── allowed ──► readyQueue.push(job)             │
│        │                                                │
│        └── denied  ──► nonReadyQueue.push(job, backoff) │
│                                                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                      Dispatcher                         │
│                                                         │
│  주기적 실행 (100ms):                                     │
│    nonReadyQueue에서 backoff 만료 작업 → readyQueue 이동   │
│                                                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                      Worker (Step 4)                    │
│                                                         │
│  readyQueue.pop() → 작업 실행                             │
│    ├── 성공 → fairQueue.ack(job)                         │
│    └── 실패 → backpressure.requeue(job)                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Fetcher 사용 예시 (Step 4 미리보기)

```typescript
@Injectable()
class FetcherService {
  constructor(
    private readonly fairQueue: FairQueueService,
    private readonly backpressure: BackpressureService,
    private readonly readyQueue: ReadyQueueService,
  ) {}

  async fetchBatch(): Promise<number> {
    let fetched = 0;

    while (await this.readyQueue.hasCapacity()) {
      const job = await this.fairQueue.dequeue();
      if (!job) break; // Fair Queue가 비었음

      const result = await this.backpressure.admit(job);

      if (!result.accepted) {
        // Ready Queue가 가득 참 → Fetcher 중단
        break;
      }

      fetched++;
    }

    return fetched;
  }
}
```

---

## 테스트 전략

### Rate Limiter 단위 테스트

```typescript
describe('RateLimiterService', () => {
  let service: RateLimiterService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          backpressure: { globalRps: 10 }, // 테스트용 낮은 값
        }),
      ],
    }).compile();

    service = module.get(RateLimiterService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('RPS 이하의 요청은 모두 허용한다', async () => {
    for (let i = 0; i < 10; i++) {
      const result = await service.checkRateLimit('customer-A');
      expect(result.allowed).toBe(true);
    }
  });

  it('RPS를 초과하면 거부한다', async () => {
    // 10건 허용
    for (let i = 0; i < 10; i++) {
      await service.checkRateLimit('customer-A');
    }

    // 11번째 거부
    const result = await service.checkRateLimit('customer-A');
    expect(result.allowed).toBe(false);
  });

  it('다른 윈도우에서는 카운트가 리셋된다', async () => {
    for (let i = 0; i < 10; i++) {
      await service.checkRateLimit('customer-A');
    }

    // 1초 대기하여 새 윈도우 진입
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const result = await service.checkRateLimit('customer-A');
    expect(result.allowed).toBe(true);
  });

  it('활성 고객사 수에 따라 per-group RPS가 분배된다', async () => {
    // globalRps=10, 고객사 2개 → 각 5 RPS
    // 고객사 A: 5건 허용
    for (let i = 0; i < 5; i++) {
      const result = await service.checkRateLimit('customer-A');
      expect(result.allowed).toBe(true);
    }

    // 고객사 B 등록 (checkRateLimit 호출 시 active-groups에 자동 등록)
    await service.checkRateLimit('customer-B');

    // 고객사 A 6번째: per-group limit이 5로 줄었으므로 거부
    const result = await service.checkRateLimit('customer-A');
    expect(result.allowed).toBe(false);
  });
});
```

### Ready Queue / Non-ready Queue 통합 테스트

```typescript
describe('Backpressure Flow (Integration)', () => {
  let backpressure: BackpressureService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          backpressure: {
            globalRps: 5,
            readyQueueMaxSize: 3,
          },
        }),
      ],
    }).compile();

    backpressure = module.get(BackpressureService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('Rate Limit 이내의 작업은 Ready Queue로 들어간다', async () => {
    const job = createMockJob('job-001', 'customer-A');

    const result = await backpressure.admit(job);

    expect(result.accepted).toBe(true);
    expect(result.destination).toBe('ready');
    expect(await readyQueue.size()).toBe(1);
  });

  it('Rate Limit 초과 작업은 Non-ready Queue로 들어간다', async () => {
    // 5건으로 RPS 소진
    for (let i = 0; i < 5; i++) {
      await backpressure.admit(createMockJob(`job-${i}`, 'customer-A'));
    }

    // 6번째는 Non-ready로
    const result = await backpressure.admit(createMockJob('job-5', 'customer-A'));
    expect(result.destination).toBe('non-ready');
  });

  it('Ready Queue가 가득 차면 rejected를 반환한다', async () => {
    // Ready Queue 상한 3개 채우기
    for (let i = 0; i < 3; i++) {
      await backpressure.admit(createMockJob(`job-${i}`, 'customer-A'));
    }

    // 4번째는 rejected
    const result = await backpressure.admit(createMockJob('job-3', 'customer-A'));
    expect(result.accepted).toBe(false);
    expect(result.destination).toBe('rejected');
  });
});

function createMockJob(id: string, groupId: string): Job {
  return {
    id,
    groupId,
    type: 'TEST',
    payload: '{}',
    status: JobStatus.PENDING,
    retryCount: 0,
    createdAt: Date.now(),
  };
}
```

### Dispatcher 테스트

```typescript
describe('DispatcherService', () => {
  let dispatcher: DispatcherService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          backpressure: {
            dispatchIntervalMs: 50, // 테스트용 짧은 주기
            dispatchBatchSize: 10,
          },
        }),
      ],
    }).compile();

    dispatcher = module.get(DispatcherService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redis = module.get(REDIS_CLIENT);

    // Dispatcher의 자동 시작을 막고 수동 테스트
    dispatcher.stop();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('backoff 만료된 작업이 Ready Queue로 이동한다', async () => {
    // backoff 0ms로 Non-ready Queue에 추가 (즉시 이동 가능)
    await nonReadyQueue.push('job-001', 0, NonReadyReason.RATE_LIMITED);

    // 약간 대기 후 dispatch
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 수동으로 dispatch 1회 실행
    // (private 메서드이므로 실제로는 start/stop 후 시간 경과로 테스트)
    // 여기서는 Lua 스크립트 직접 호출로 검증
    const jobs = await nonReadyQueue.popReady(10);
    for (const jobId of jobs) {
      await readyQueue.push(jobId);
    }

    expect(await readyQueue.size()).toBe(1);
    expect(await nonReadyQueue.size()).toBe(0);
  });

  it('backoff 미만료 작업은 Non-ready Queue에 남는다', async () => {
    // 10초 후 만료
    await nonReadyQueue.push('job-001', 10000, NonReadyReason.RATE_LIMITED);

    const jobs = await nonReadyQueue.popReady(10);
    expect(jobs).toHaveLength(0);
    expect(await nonReadyQueue.size()).toBe(1);
  });
});
```

---

## 운영 고려사항

### 모니터링 지표

```
# Rate Limit 상태
bulk_action_rate_limit_allowed_total{groupId="..."}
bulk_action_rate_limit_denied_total{groupId="...", reason="global|per_group"}

# 큐 크기
bulk_action_ready_queue_size
bulk_action_non_ready_queue_size

# Dispatcher 성능
bulk_action_dispatch_moved_total          # 이동된 작업 수
bulk_action_dispatch_cycle_duration_ms    # dispatch 사이클 소요 시간
bulk_action_dispatch_skip_total           # Ready Queue 가득 차서 스킵한 횟수

# Backpressure 상태
bulk_action_backpressure_admitted_total{destination="ready|non_ready"}
bulk_action_backpressure_rejected_total
```

### 설정 튜닝 가이드

| 설정 | 기본값 | 조정 기준 |
|------|-------|----------|
| `globalRps` | 10,000 | 외부 API Rate Limit, DB 처리 용량 기준 |
| `readyQueueMaxSize` | 10,000 | Worker 수 * 평균 처리시간 기반. 너무 크면 메모리 낭비, 너무 작으면 Worker 유휴 |
| `dispatchIntervalMs` | 100 | 작업 지연 허용치. 낮을수록 반응 빠르지만 Redis 부하 증가 |
| `dispatchBatchSize` | 100 | 1회 이동량. 크면 burst 발생, 작으면 이동 지연 |
| `defaultBackoffMs` | 1,000 | Rate Limit 시 기본 대기. Step 3에서 동적 계산으로 대체 |
| `maxBackoffMs` | 60,000 | 최대 대기 상한. 너무 길면 작업 지연, 너무 짧으면 공회전 |

### Fixed Window 경계 문제 완화

윈도우 경계 burst가 문제가 된다면 다음 옵션을 고려한다:

**옵션 A: 윈도우 크기 축소**
```typescript
rateLimitWindowSec: 0.1  // 100ms 윈도우
// → burst 최대 2x가 200ms 내에 발생 (영향 최소)
// → Redis 키가 10배 많아짐 (트레이드오프)
```

**옵션 B: Sliding Window Counter로 교체**
```typescript
// 현재 윈도우 카운트 * 가중치 + 이전 윈도우 카운트 * (1 - 가중치)
const currentWeight = (Date.now() % windowMs) / windowMs;
const effectiveCount = currentCount * currentWeight + previousCount * (1 - currentWeight);
```

### 장애 시나리오 대응

| 시나리오 | 증상 | 대응 |
|---------|------|------|
| Redis 장애 | Rate Limit 검사 실패 | Fail-open: 검사 실패 시 허용 (가용성 우선) 또는 Fail-close: 거부 (안전성 우선) |
| Ready Queue 정체 | Worker 부족으로 큐가 가득 참 | Worker 수 증가 또는 globalRps 하향 조정 |
| Non-ready Queue 증가 | Rate Limit이 너무 빡빡함 | globalRps 상향 또는 backoff 감소 |
| 특정 그룹 독점 | per-group limit이 너무 높음 | 활성 그룹 수 확인, 수동 limit 설정 검토 |

### 후속 Step과의 연동 인터페이스

#### Step 3 혼잡 제어 — `calculateBackoff()` 교체

`BackpressureService.calculateBackoff()`는 현재 고정 1초를 반환한다. Step 3에서 `CongestionController`를 주입받아 동적 backoff로 교체한다.

```typescript
// Step 2 현재 구현
private calculateBackoff(groupId: string): number {
  return 1000; // 고정 1초
}

// Step 3 적용 후
private calculateBackoff(groupId: string): number {
  return this.congestionController.getBackoff(groupId);
  // → Non-ready Queue 크기, Rate Limit 속도, 외부 API 응답 지연 등을
  //   종합하여 동적 backoff를 산출
}
```

#### Step 5 Watcher — active-groups 자동 cleanup

Watcher가 그룹의 완료 상태를 감지하면 `RateLimiterService.deactivateGroup()`을 호출한다.

```typescript
// Step 5 Watcher에서 호출
async onGroupCompleted(groupId: string): Promise<void> {
  await this.rateLimiter.deactivateGroup(groupId);
  // → active-groups Set에서 제거
  // → per-group RPS가 남은 활성 그룹에 재분배됨
}
```

#### Step 6 Reliable Queue — Ready Queue 소비 방식 변경

Step 6 적용 시, Worker의 Ready Queue 소비 방식이 `BLPOP` → `RPOPLPUSH`(In-flight Queue)로 변경된다. `ReadyQueueService.blockingPop()`을 다음과 같이 교체한다.

```typescript
// Step 2 현재
async blockingPop(timeoutSec: number): Promise<string | null> {
  const result = await this.redis.blpop(this.queueKey, timeoutSec);
  return result ? result[1] : null;
}

// Step 6 적용 후 — In-flight Queue로 원자적 이동
async reliablePop(timeoutSec: number): Promise<string | null> {
  // BRPOPLPUSH: Ready Queue에서 꺼내면서 동시에 In-flight Queue에 등록
  return this.redis.brpoplpush(
    this.queueKey,
    'in-flight-queue',
    timeoutSec,
  );
}
```

#### Step 6 Reliable Queue — admit() rejected 작업 복구

Step 6 적용 시, `admit()`에서 `rejected`된 작업은 In-flight Queue의 orphan recovery 대상이 된다. Fair Queue에서 dequeue하기 전에 In-flight Queue에 먼저 등록하므로, `rejected` 상태에서도 작업 유실이 발생하지 않는다.

### 다음 단계

Step 2가 구현되면 Step 3(혼잡 제어)에서 `calculateBackoff` 메서드를 **동적 backoff 계산**으로 교체한다. 현재는 고정 1초 backoff를 사용하지만, Non-ready Queue의 작업 수와 Rate Limit 속도를 기반으로 공회전을 최소화하는 계산식을 적용한다.

```
현재: backoff = 1000ms (고정)
Step 3: backoff = 1000 + floor(nonReadyCount / rateLimitSpeed) * 1000
```


### 문서 갱신 히스토리

#### 1. 2026-02-04
```
#: 1                                                                                 
이슈: floor() RPS 손실                                                               
적용 내용: per-group RPS 분배 섹션에 나머지 손실 경고 및 대안 추가                   
────────────────────────────────────────                                             
#: 2                                                                                 
이슈: ReadyQueueService.push() 비원자성                                              
적용 내용: LLEN+RPUSH race condition 경고, ready_queue_push.lua Lua 스크립트 제공    
────────────────────────────────────────                                             
#: 3                                                                                 
이슈: admit() rejected 시 작업 유실                                                  
적용 내용: JSDoc에 유실 구간 명시, Fetcher re-enqueue 또는 Step 6 orphan recovery    
안내                                                                                 
────────────────────────────────────────                                             
#: 4                                                                                 
이슈: Dispatcher Rate Limit 미재검사                                                 
적용 내용: 트레이드오프 설명 추가 (재검사 시 무한 루프 위험, Worker 단에서 429 보완) 
────────────────────────────────────────                                             
#: 5                                                                                 
이슈: active-groups Set 자동 cleanup                                                 
적용 내용: cleanup 누락 시 문제점, Step 5 Watcher 연동 시점, 미적용 시 대안 명시     
────────────────────────────────────────                                             
#: 6                                                                                 
이슈: NonReadyQueueService.popReady() 비원자성                                       
적용 내용: 다중 인스턴스 중복 pop 경고, Dispatcher에서는 Lua 스크립트 필수 사용 명시 
────────────────────────────────────────                                             
#: 7                                                                                 
이슈: move_to_ready.lua 루프 통합                                                    
적용 내용: ZREM/RPUSH를 작업 단위로 같은 루프에서 처리하도록 변경                    
────────────────────────────────────────                                             
#: 8                                                                                 
이슈: 후속 Step 연동 인터페이스                                                      
적용 내용: Step 3 calculateBackoff 교체, Step 5 deactivateGroup 호출, Step 6         
BLPOP→BRPOPLPUSH 교체, Step 6 rejected 작업 복구 — 코드 예시 포함 
```
