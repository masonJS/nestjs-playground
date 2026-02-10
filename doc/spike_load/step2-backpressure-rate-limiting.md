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

### Lua 스크립트: rate-limit-check.lua

> Lua 스크립트 파일명은 kebab-case이며, `LuaScriptLoader`에서 camelCase 커맨드명으로 등록된다 (예: `rate-limit-check.lua` → `rateLimitCheck`).

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
-- move-to-ready.lua (커맨드명: moveToReady)
-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- ARGV[1]: 현재 시각 (epoch ms)
-- ARGV[2]: 최대 이동 수 (batch size)
-- ARGV[3]: key prefix (e.g., "bulk-action:")

-- score <= now인 작업을 최대 ARGV[2]개 조회
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #jobs == 0 then
  return 0
end

local prefix = ARGV[3]

-- Non-ready Queue에서 제거 + Ready Queue에 추가를 같은 루프에서 처리
-- ZREM → RPUSH를 작업 단위로 묶어야, 중간에 오류 발생 시 정합성 추적이 용이하다.
-- Step 3 연동: 각 작업의 groupId를 조회하여 congestion 카운터도 함께 감소시킨다.
for _, jobId in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('RPUSH', KEYS[2], jobId)

  -- congestion 카운터 감소 (Step 3 연동)
  local jobKey = prefix .. 'job:' .. jobId
  local groupId = redis.call('HGET', jobKey, 'groupId')
  if groupId then
    local countKey = prefix .. 'congestion:' .. groupId .. ':non-ready-count'
    local newCount = redis.call('DECR', countKey)
    if newCount < 0 then
      redis.call('SET', countKey, '0')
      newCount = 0
    end
  end
end

return #jobs
```

> **ready-queue-push.lua** (커맨드명: `readyQueuePush`) — Ready Queue 원자적 push
>
> ```lua
> -- ready-queue-push.lua
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
│   ├── BackpressureService.ts            # 통합 오케스트레이터
│   ├── RateLimiterService.ts             # Fixed Window Rate Limiter
│   ├── ReadyQueueService.ts              # Ready Queue 관리
│   ├── NonReadyQueueService.ts           # Non-ready Queue 관리
│   └── DispatcherService.ts              # Non-ready → Ready 이동
├── config/
│   └── BulkActionConfig.ts               # 설정 (backpressure + congestion + workerPool)
├── key/
│   └── RedisKeyBuilder.ts                # Redis 키 빌더 (동적 prefix 지원)
└── lua/
    ├── LuaScriptLoader.ts                # Lua 스크립트 로더
    ├── rate-limit-check.lua              # Rate Limit 검사
    ├── ready-queue-push.lua              # Ready Queue 원자적 push (LLEN+RPUSH)
    └── move-to-ready.lua                 # Non-ready → Ready 이동
```

### 설정 확장

**`config/BulkActionConfig.ts`** (Step 1에서 확장)

```typescript
import { RedisConfig } from '@app/redis/RedisConfig';

export const BULK_ACTION_CONFIG = Symbol('BULK_ACTION_CONFIG');

export interface BulkActionRedisConfig extends RedisConfig {
  keyPrefix?: string;
}

export interface FairQueueConfig {
  alpha: number;
}

export interface BackpressureConfig {
  globalRps: number;          // 전체 RPS 상한 (default: 10000)
  readyQueueMaxSize: number;  // Ready Queue 최대 크기 (default: 10000)
  rateLimitWindowSec: number; // Rate Limit 윈도우 크기 (default: 1)
  rateLimitKeyTtlSec: number; // Rate Limit 키 TTL (default: 2)
  dispatchIntervalMs: number; // Dispatcher 실행 주기 (default: 100)
  dispatchBatchSize: number;  // Dispatcher 1회 이동량 (default: 100)
  defaultBackoffMs: number;   // 기본 backoff 시간 (default: 1000)
  maxBackoffMs: number;       // 최대 backoff 시간 (default: 60000)
}

export interface CongestionConfig {
  enabled: boolean;           // 혼잡 제어 활성화 여부 (default: true)
  baseBackoffMs: number;      // 기본 backoff 시간 (default: 1000)
  maxBackoffMs: number;       // 최대 backoff 시간 (default: 120000)
  statsRetentionMs: number;   // 통계 보존 시간 (default: 3600000)
}

export interface WorkerPoolConfig {
  workerCount: number;          // Worker 수 (default: 10)
  fetchIntervalMs: number;      // Fetcher 실행 주기 (default: 200)
  fetchBatchSize: number;       // Fetcher 1회 가져오기 수 (default: 50)
  workerTimeoutSec: number;     // Worker 블로킹 타임아웃 (default: 5)
  jobTimeoutMs: number;         // 작업 타임아웃 (default: 30000)
  maxRetryCount: number;        // 최대 재시도 횟수 (default: 3)
  shutdownGracePeriodMs: number;// 종료 유예 시간 (default: 30000)
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;
}
```

각 섹션별 기본값은 별도 상수로 분리되어 있다:

```typescript
export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  globalRps: 10000,
  readyQueueMaxSize: 10000,
  rateLimitWindowSec: 1,
  rateLimitKeyTtlSec: 2,
  dispatchIntervalMs: 100,
  dispatchBatchSize: 100,
  defaultBackoffMs: 1000,
  maxBackoffMs: 60000,
};

export const DEFAULT_CONGESTION_CONFIG: CongestionConfig = {
  enabled: true,
  baseBackoffMs: 1000,
  maxBackoffMs: 120000,
  statsRetentionMs: 3600000,
};

export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  workerCount: 10,
  fetchIntervalMs: 200,
  fetchBatchSize: 50,
  workerTimeoutSec: 5,
  jobTimeoutMs: 30000,
  maxRetryCount: 3,
  shutdownGracePeriodMs: 30000,
};
```

---

## 구현 코드

### Rate Limiter Service

**`backpressure/RateLimiterService.ts`**

> 모든 서비스는 raw ioredis 대신 `RedisService` 래퍼를 주입받고, 키 생성은 `RedisKeyBuilder`에 위임한다.

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

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
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async checkRateLimit(groupId: string): Promise<RateLimitResult> {
    const { globalRps, rateLimitKeyTtlSec } = this.config.backpressure;
    const window = this.currentWindow();

    const result = (await this.redisService.callCommand(
      'rateLimitCheck',
      [
        this.keys.rateLimitGroup(groupId, window),
        this.keys.rateLimitGlobal(window),
        this.keys.activeGroups(),
      ],
      [globalRps.toString(), groupId, rateLimitKeyTtlSec.toString()],
    )) as number[];

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
  }

  async getStatus(groupId: string): Promise<{
    globalCount: number;
    globalLimit: number;
    groupCount: number;
    perGroupLimit: number;
    activeGroupCount: number;
  }> {
    const window = this.currentWindow();

    const [globalRaw, groupRaw, activeGroupCount] = await Promise.all([
      this.redisService.string.get(this.keys.rateLimitGlobal(window)),
      this.redisService.string.get(this.keys.rateLimitGroup(groupId, window)),
      this.redisService.set.size(this.keys.activeGroups()),
    ]);

    const globalCount = parseInt(globalRaw ?? '0', 10);
    const groupCount = parseInt(groupRaw ?? '0', 10);
    const perGroupLimit = Math.max(
      1,
      Math.floor(
        this.config.backpressure.globalRps / Math.max(1, activeGroupCount),
      ),
    );

    return {
      globalCount,
      globalLimit: this.config.backpressure.globalRps,
      groupCount,
      perGroupLimit,
      activeGroupCount,
    };
  }

  async deactivateGroup(groupId: string): Promise<void> {
    await this.redisService.set.remove(this.keys.activeGroups(), groupId);
    this.logger.debug(`Deactivated group: ${groupId}`);
  }

  private currentWindow(): number {
    return Math.floor(
      Date.now() / (this.config.backpressure.rateLimitWindowSec * 1000),
    );
  }
}
```

### Ready Queue Service

**`backpressure/ReadyQueueService.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

@Injectable()
export class ReadyQueueService {
  private readonly logger = new Logger(ReadyQueueService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  /**
   * Ready Queue에 작업을 추가한다.
   * Lua 스크립트(readyQueuePush)로 LLEN + RPUSH를 원자적으로 처리한다.
   * 큐 크기가 상한에 도달하면 false를 반환한다.
   */
  async push(jobId: string): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'readyQueuePush',
      [this.keys.readyQueue()],
      [jobId, this.config.backpressure.readyQueueMaxSize.toString()],
    );

    if (result === 0) {
      this.logger.warn(
        `Ready Queue full: maxSize=${this.config.backpressure.readyQueueMaxSize}`,
      );

      return false;
    }

    return true;
  }

  async pop(): Promise<string | null> {
    return this.redisService.list.popHead(this.keys.readyQueue());
  }

  async blockingPop(timeoutSec: number): Promise<string | null> {
    return this.redisService.list.blockingPopHead(
      this.keys.readyQueue(),
      timeoutSec,
    );
  }

  async size(): Promise<number> {
    return this.redisService.list.length(this.keys.readyQueue());
  }

  async hasCapacity(): Promise<boolean> {
    const currentSize = await this.redisService.list.length(
      this.keys.readyQueue(),
    );

    return currentSize < this.config.backpressure.readyQueueMaxSize;
  }
}
```

### Non-ready Queue Service

**`backpressure/NonReadyQueueService.ts`**

> 그룹별 카운팅 메서드(`incrementGroupCount`, `decrementGroupCount`, `countByGroup`)는 Step 3 혼잡 제어 구현 시 `CongestionControlService`로 이관되어 제거되었다.

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export enum NonReadyReason {
  RATE_LIMITED = 'RATE_LIMITED',
  API_THROTTLED = 'API_THROTTLED',
  TRANSIENT_ERROR = 'TRANSIENT_ERROR',
}

@Injectable()
export class NonReadyQueueService {
  private readonly logger = new Logger(NonReadyQueueService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async push(jobId: string, backoffMs: number, reason: NonReadyReason): Promise<void> {
    const clampedBackoff = Math.min(backoffMs, this.config.backpressure.maxBackoffMs);
    const executeAt = Date.now() + clampedBackoff;

    await this.redisService.sortedSet.add(
      this.keys.nonReadyQueue(),
      executeAt,
      jobId,
    );

    this.logger.debug(
      `Job ${jobId} -> Non-ready Queue (reason=${reason}, backoff=${clampedBackoff}ms)`,
    );
  }

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

  async peekReady(limit: number): Promise<string[]> {
    const now = Date.now().toString();

    return this.redisService.sortedSet.rangeByScore(
      this.keys.nonReadyQueue(),
      '-inf',
      now,
      0,
      limit,
    );
  }

  /**
   * ⚠️ 비원자성 경고:
   * ZRANGEBYSCORE와 ZREM이 별도 명령으로 실행되므로, 다중 인스턴스 환경에서
   * 두 인스턴스가 동시에 같은 작업을 조회하여 중복 처리할 수 있다.
   * Dispatcher에서는 반드시 moveToReady Lua 스크립트를 통해 원자적으로 처리해야 하며,
   * 이 메서드는 단일 인스턴스 테스트 또는 디버깅 용도로만 사용한다.
   */
  async popReady(limit: number): Promise<string[]> {
    const now = Date.now().toString();
    const jobs = await this.redisService.sortedSet.rangeByScore(
      this.keys.nonReadyQueue(),
      '-inf',
      now,
      0,
      limit,
    );

    if (jobs.length > 0) {
      await this.redisService.sortedSet.remove(
        this.keys.nonReadyQueue(),
        ...jobs,
      );
    }

    return jobs;
  }

  async remove(jobId: string): Promise<void> {
    await this.redisService.sortedSet.remove(this.keys.nonReadyQueue(), jobId);
  }

  async size(): Promise<number> {
    return this.redisService.sortedSet.count(this.keys.nonReadyQueue());
  }
}
```

### Dispatcher Service

**`backpressure/DispatcherService.ts`**

```typescript
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { ReadyQueueService } from './ReadyQueueService';

export enum DispatcherState {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
}

@Injectable()
export class DispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private state: DispatcherState = DispatcherState.IDLE;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private stats = {
    totalMoved: 0,
    totalCycles: 0,
    totalSkipped: 0,
  };

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly readyQueue: ReadyQueueService,
  ) {}

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.state === DispatcherState.RUNNING) {
      return;
    }

    this.state = DispatcherState.RUNNING;
    this.intervalHandle = setInterval(
      () => void this.dispatch(),
      this.config.backpressure.dispatchIntervalMs,
    );

    this.logger.log(
      `Dispatcher started (interval=${this.config.backpressure.dispatchIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.state = DispatcherState.STOPPED;
    this.logger.log('Dispatcher stopped');
  }

  getState(): DispatcherState {
    return this.state;
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /** 테스트에서 수동으로 1회 dispatch를 실행할 때 사용한다. */
  async dispatchOnce(): Promise<number> {
    return this.dispatch();
  }

  private async dispatch(): Promise<number> {
    if (this.isRunning) {
      return 0;
    }
    this.isRunning = true;

    try {
      this.stats.totalCycles++;

      const hasCapacity = await this.readyQueue.hasCapacity();

      if (!hasCapacity) {
        this.stats.totalSkipped++;
        this.logger.debug('Ready Queue full, skipping dispatch');

        return 0;
      }

      const moved = await this.moveToReady();

      if (moved > 0) {
        this.stats.totalMoved += moved;
        this.logger.debug(
          `Dispatched ${moved} jobs from Non-ready -> Ready Queue`,
        );
      }

      return moved;
    } catch (error) {
      this.logger.error(
        `Dispatch failed: ${(error as Error).message}`,
        (error as Error).stack,
      );

      return 0;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Lua 스크립트를 사용하여 원자적으로 Non-ready → Ready Queue 이동을 수행한다.
   * ARGV[3]으로 prefix를 전달하여 Lua 내부에서 congestion 카운터도 함께 갱신한다.
   */
  private async moveToReady(): Promise<number> {
    const result = await this.redisService.callCommand(
      'moveToReady',
      [this.keys.nonReadyQueue(), this.keys.readyQueue()],
      [
        Date.now().toString(),
        this.config.backpressure.dispatchBatchSize.toString(),
        this.keys.getPrefix(),
      ],
    );

    return result as number;
  }
}
```

### Backpressure 통합 서비스

Fair Queue에서 꺼낸 작업을 Rate Limit 검사 후 적절한 큐로 분배하는 오케스트레이터이다.

**`backpressure/BackpressureService.ts`**

> Step 3 혼잡 제어 구현 완료로, Rate Limit 초과 시 `CongestionControlService.addToNonReady()`에 위임한다.
> 기존 `calculateBackoff()` 메서드와 `NonReadyQueueService` 직접 의존은 제거되었다.

```typescript
import { Injectable } from '@nestjs/common';
import { RateLimiterService } from './RateLimiterService';
import { ReadyQueueService } from './ReadyQueueService';
import { CongestionControlService } from '../congestion/CongestionControlService';
import { Job } from '../model/Job';

export interface BackpressureResult {
  accepted: boolean;
  destination: 'ready' | 'non-ready' | 'rejected';
  reason?: string;
}

@Injectable()
export class BackpressureService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly readyQueue: ReadyQueueService,
    private readonly congestionControl: CongestionControlService,
  ) {}

  /**
   * Fair Queue에서 dequeue된 작업을 Rate Limit 검사 후
   * Ready Queue 또는 Non-ready Queue로 분배한다.
   *
   * ⚠️ 작업 유실 구간:
   * `accepted: false` (rejected)를 반환하면 작업은 Fair Queue에서 이미 dequeue된 상태이지만
   * Ready Queue에도 Non-ready Queue에도 들어가지 않는다.
   * 호출자(Fetcher)가 rejected를 받으면 반드시 작업을 Fair Queue에 re-enqueue하거나,
   * Step 6의 In-flight Queue에서 orphan recovery로 복구해야 한다.
   */
  async admit(job: Job): Promise<BackpressureResult> {
    const hasCapacity = await this.readyQueue.hasCapacity();

    if (!hasCapacity) {
      return {
        accepted: false,
        destination: 'rejected',
        reason: 'Ready Queue at capacity',
      };
    }

    const rateLimitResult = await this.rateLimiter.checkRateLimit(job.groupId);

    if (rateLimitResult.allowed) {
      const pushed = await this.readyQueue.push(job.id);

      if (!pushed) {
        return {
          accepted: false,
          destination: 'rejected',
          reason: 'Ready Queue became full',
        };
      }

      return { accepted: true, destination: 'ready' };
    }

    // Rate Limit 초과 → CongestionControlService가 동적 backoff 계산 후 Non-ready Queue에 추가
    const backoffResult = await this.congestionControl.addToNonReady(
      job.id,
      job.groupId,
    );

    return {
      accepted: true,
      destination: 'non-ready',
      reason:
        `Rate limited (global: ${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
        `group: ${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit}, ` +
        `congestion: ${backoffResult.congestionLevel})`,
    };
  }

  async requeue(
    jobId: string,
    groupId: string,
    _retryCount: number,
  ): Promise<void> {
    await this.congestionControl.addToNonReady(jobId, groupId);
  }
}
```

### 모듈 등록

**`BulkActionModule.ts`** (Step 1에서 확장)

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis/RedisModule';
import { BackpressureService } from './backpressure/BackpressureService';
import { DispatcherService } from './backpressure/DispatcherService';
import { NonReadyQueueService } from './backpressure/NonReadyQueueService';
import { RateLimiterService } from './backpressure/RateLimiterService';
import { ReadyQueueService } from './backpressure/ReadyQueueService';
import {
  BackpressureConfig,
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  BulkActionRedisConfig,
  CongestionConfig,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
  FairQueueConfig,
  WorkerPoolConfig,
} from './config/BulkActionConfig';
import { CongestionControlService } from './congestion/CongestionControlService';
import { CongestionStatsService } from './congestion/CongestionStatsService';
import { FairQueueService } from './fair-queue/FairQueueService';
import { RedisKeyBuilder } from './key/RedisKeyBuilder';
import { LuaScriptLoader } from './lua/LuaScriptLoader';
import { FetcherService } from './worker-pool/FetcherService';
import { JOB_PROCESSOR } from './worker-pool/JobProcessor';
import { WorkerPoolService } from './worker-pool/WorkerPoolService';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: BulkActionRedisConfig } & {
      fairQueue?: Partial<FairQueueConfig>;
      backpressure?: Partial<BackpressureConfig>;
      congestion?: Partial<CongestionConfig>;
      workerPool?: Partial<WorkerPoolConfig>;
    },
  ): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      redis: config.redis,
      fairQueue: { ...DEFAULT_FAIR_QUEUE_CONFIG, ...config.fairQueue },
      backpressure: { ...DEFAULT_BACKPRESSURE_CONFIG, ...config.backpressure },
      congestion: { ...DEFAULT_CONGESTION_CONFIG, ...config.congestion },
      workerPool: { ...DEFAULT_WORKER_POOL_CONFIG, ...config.workerPool },
    };

    return {
      module: BulkActionModule,
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: mergedConfig },
        RedisKeyBuilder,
        LuaScriptLoader,
        FairQueueService,
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        DispatcherService,
        BackpressureService,
        CongestionControlService,
        CongestionStatsService,
        // Step 4
        FetcherService,
        WorkerPoolService,
        { provide: JOB_PROCESSOR, useValue: [] },
      ],
      exports: [
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        CongestionControlService,
        WorkerPoolService,
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

> 테스트에서는 `BulkActionModule.register()`를 사용하지 않고, 필요한 서비스만 직접 등록한다.
> `BulkActionConfig`의 모든 섹션(`fairQueue`, `backpressure`, `congestion`, `workerPool`)을 명시적으로 제공해야 한다.
> `DEFAULT_*_CONFIG` 상수를 활용하면 관심 없는 섹션의 기본값을 쉽게 채울 수 있다.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { RateLimiterService } from '@app/bulk-action/backpressure/RateLimiterService';

describe('RateLimiterService', () => {
  let module: TestingModule;
  let service: RateLimiterService;
  let redisService: RedisService;

  const KEY_PREFIX = 'test:';
  const env = Configuration.getEnv();

  const config: BulkActionConfig = {
    redis: {
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      db: env.redis.db,
      keyPrefix: KEY_PREFIX,
    },
    fairQueue: DEFAULT_FAIR_QUEUE_CONFIG,
    backpressure: {
      globalRps: 10,
      readyQueueMaxSize: 10000,
      rateLimitWindowSec: 1,
      rateLimitKeyTtlSec: 2,
      dispatchIntervalMs: 100,
      dispatchBatchSize: 100,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
    congestion: DEFAULT_CONGESTION_CONFIG,
    workerPool: DEFAULT_WORKER_POOL_CONFIG,
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: config },
        RedisKeyBuilder,
        LuaScriptLoader,
        RateLimiterService,
      ],
    }).compile();

    await module.init();

    service = module.get(RateLimiterService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  it('RPS 이하의 요청은 모두 허용한다', async () => {
    // given & when
    const results = [];

    for (let i = 0; i < 10; i++) {
      const result = await service.checkRateLimit('customer-A');
      results.push(result);
    }

    // then
    for (const result of results) {
      expect(result.allowed).toBe(true);
    }
  });

  it('RPS를 초과하면 거부한다', async () => {
    // given - 10건 허용
    for (let i = 0; i < 10; i++) {
      await service.checkRateLimit('customer-A');
    }

    // when - 11번째
    const result = await service.checkRateLimit('customer-A');

    // then
    expect(result.allowed).toBe(false);
  });

  it('거부 시 카운터가 롤백되어 이전 카운트를 반환한다', async () => {
    // given
    for (let i = 0; i < 10; i++) {
      await service.checkRateLimit('customer-A');
    }

    // when
    const result = await service.checkRateLimit('customer-A');

    // then
    expect(result.allowed).toBe(false);
    expect(result.globalCount).toBe(10);
    expect(result.globalLimit).toBe(10);
  });

  it('다른 윈도우에서는 카운트가 리셋된다', async () => {
    // given
    for (let i = 0; i < 10; i++) {
      await service.checkRateLimit('customer-A');
    }

    // when - 1초 대기하여 새 윈도우 진입
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await service.checkRateLimit('customer-A');

    // then
    expect(result.allowed).toBe(true);
    expect(result.globalCount).toBe(1);
  }, 10000);

  it('활성 고객사 수에 따라 per-group RPS가 분배된다', async () => {
    // given - globalRps=10, 고객사 A만 있을 때 10 RPS
    for (let i = 0; i < 5; i++) {
      const result = await service.checkRateLimit('customer-A');
      expect(result.allowed).toBe(true);
    }

    // when - 고객사 B 등록 (checkRateLimit 호출 시 active-groups에 자동 등록)
    await service.checkRateLimit('customer-B');

    // then - 고객사 A 6번째: per-group limit이 5로 줄었으므로 거부
    const result = await service.checkRateLimit('customer-A');
    expect(result.allowed).toBe(false);
    expect(result.perGroupLimit).toBe(5);
  });

  it('global limit에 먼저 걸리면 per-group과 무관하게 거부한다', async () => {
    // given - globalRps=10, 고객사 2개가 각각 5건씩 → 총 10건
    for (let i = 0; i < 5; i++) {
      await service.checkRateLimit('customer-A');
    }

    for (let i = 0; i < 5; i++) {
      await service.checkRateLimit('customer-B');
    }

    // when - 11번째 요청 (고객사 C, per-group은 여유 있지만 global 초과)
    const result = await service.checkRateLimit('customer-C');

    // then
    expect(result.allowed).toBe(false);
  });
});
```

### Backpressure 통합 테스트

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { RateLimiterService } from '@app/bulk-action/backpressure/RateLimiterService';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { NonReadyQueueService } from '@app/bulk-action/backpressure/NonReadyQueueService';
import { BackpressureService } from '@app/bulk-action/backpressure/BackpressureService';
import { CongestionControlService } from '@app/bulk-action/congestion/CongestionControlService';
import { Job, JobStatus } from '@app/bulk-action/model/Job';

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

describe('BackpressureService', () => {
  let module: TestingModule;
  let backpressure: BackpressureService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
  let redisService: RedisService;

  const KEY_PREFIX = 'test:';
  const env = Configuration.getEnv();

  const config: BulkActionConfig = {
    redis: {
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      db: env.redis.db,
      keyPrefix: KEY_PREFIX,
    },
    fairQueue: DEFAULT_FAIR_QUEUE_CONFIG,
    backpressure: {
      globalRps: 5,
      readyQueueMaxSize: 10,
      rateLimitWindowSec: 10,
      rateLimitKeyTtlSec: 12,
      dispatchIntervalMs: 100,
      dispatchBatchSize: 100,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
    congestion: DEFAULT_CONGESTION_CONFIG,
    workerPool: DEFAULT_WORKER_POOL_CONFIG,
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: config },
        RedisKeyBuilder,
        LuaScriptLoader,
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        CongestionControlService,
        BackpressureService,
      ],
    }).compile();

    await module.init();

    backpressure = module.get(BackpressureService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  it('Rate Limit 이내의 작업은 Ready Queue로 들어간다', async () => {
    // given
    const job = createMockJob('job-001', 'customer-A');

    // when
    const result = await backpressure.admit(job);

    // then
    expect(result.accepted).toBe(true);
    expect(result.destination).toBe('ready');
    expect(await readyQueue.size()).toBe(1);
  });

  it('Rate Limit 초과 작업은 Non-ready Queue로 들어간다', async () => {
    // given - 5건으로 RPS 소진
    for (let i = 0; i < 5; i++) {
      await backpressure.admit(createMockJob(`job-${i}`, 'customer-A'));
    }

    // when - 6번째
    const result = await backpressure.admit(
      createMockJob('job-5', 'customer-A'),
    );

    // then
    expect(result.accepted).toBe(true);
    expect(result.destination).toBe('non-ready');
    expect(result.reason).toContain('Rate limited');
    expect(await nonReadyQueue.size()).toBe(1);
  });

  it('Ready Queue가 가득 차면 rejected를 반환한다', async () => {
    // given - readyQueueMaxSize=10 직접 채우기
    for (let i = 0; i < 10; i++) {
      await readyQueue.push(`fill-${i}`);
    }

    // when
    const result = await backpressure.admit(
      createMockJob('job-overflow', 'customer-A'),
    );

    // then
    expect(result.accepted).toBe(false);
    expect(result.destination).toBe('rejected');
  });

  it('다른 고객사 간 Rate Limit이 분배된다', async () => {
    // given - globalRps=5, 고객사 2개 → 각 2 RPS (floor(5/2))
    await backpressure.admit(createMockJob('A-1', 'customer-A'));
    await backpressure.admit(createMockJob('A-2', 'customer-A'));
    await backpressure.admit(createMockJob('B-1', 'customer-B'));

    // when - 고객사 A 3번째 (per-group limit 초과)
    const result = await backpressure.admit(
      createMockJob('A-3', 'customer-A'),
    );

    // then
    expect(result.destination).toBe('non-ready');
  });
});
```

### Dispatcher 테스트

> `DispatcherService`는 `dispatchOnce()` 공개 메서드를 제공하므로 테스트에서 수동으로 1회 사이클을 실행할 수 있다.

```typescript
describe('DispatcherService', () => {
  let module: TestingModule;
  let dispatcher: DispatcherService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
  let redisService: RedisService;

  const KEY_PREFIX = 'test:';
  const env = Configuration.getEnv();

  const config: BulkActionConfig = {
    redis: { ...env.redis, keyPrefix: KEY_PREFIX },
    fairQueue: DEFAULT_FAIR_QUEUE_CONFIG,
    backpressure: {
      globalRps: 10000,
      readyQueueMaxSize: 10000,
      rateLimitWindowSec: 1,
      rateLimitKeyTtlSec: 2,
      dispatchIntervalMs: 50,
      dispatchBatchSize: 10,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
    congestion: DEFAULT_CONGESTION_CONFIG,
    workerPool: DEFAULT_WORKER_POOL_CONFIG,
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: config },
        RedisKeyBuilder,
        LuaScriptLoader,
        ReadyQueueService,
        NonReadyQueueService,
        DispatcherService,
      ],
    }).compile();

    await module.init();

    dispatcher = module.get(DispatcherService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  it('backoff 만료된 작업이 Ready Queue로 이동한다', async () => {
    // given - backoff 0ms (즉시 이동 가능)
    await nonReadyQueue.push('job-001', 0, NonReadyReason.RATE_LIMITED);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // when - dispatchOnce()로 수동 실행
    const moved = await dispatcher.dispatchOnce();

    // then
    expect(moved).toBe(1);
    expect(await readyQueue.size()).toBe(1);
    expect(await nonReadyQueue.size()).toBe(0);
  });

  it('backoff 미만료 작업은 Non-ready Queue에 남는다', async () => {
    // given - 10초 후 만료
    await nonReadyQueue.push('job-001', 10000, NonReadyReason.RATE_LIMITED);

    // when
    const moved = await dispatcher.dispatchOnce();

    // then
    expect(moved).toBe(0);
    expect(await nonReadyQueue.size()).toBe(1);
  });

  it('dispatch 통계를 추적한다', async () => {
    // when
    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();

    // then
    const stats = dispatcher.getStats();
    expect(stats.totalCycles).toBe(2);
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

#### Step 3 혼잡 제어 — ✅ 구현 완료

`BackpressureService`에서 `calculateBackoff()` 메서드가 제거되고, `CongestionControlService.addToNonReady()`로 위임하는 방식으로 교체되었다.

```typescript
// 적용 결과 — BackpressureService.admit() 내부
const backoffResult = await this.congestionControl.addToNonReady(
  job.id,
  job.groupId,
);
// → CongestionControlService가 Non-ready Queue 크기, Rate Limit 속도 등을
//   종합하여 동적 backoff를 산출 후 Non-ready Queue에 추가
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

Step 3(혼잡 제어)는 구현 완료되어 `CongestionControlService`가 동적 backoff를 산출한다.

```
적용된 계산식: backoff = baseBackoffMs + floor(nonReadyCount / rateLimitSpeed) * 1000
```

Step 5(Watcher)와 Step 6(Reliable Queue)은 미구현 상태이다.


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

#### 2. 2026-02-10
```
#: 9
이슈: Redis 접근 패턴 변경
적용 내용: raw ioredis → RedisService 래퍼 사용으로 전체 구현 코드 갱신
────────────────────────────────────────
#: 10
이슈: RedisKeyBuilder 추상화 추가
적용 내용: 하드코딩된 Redis 키 → RedisKeyBuilder 주입 패턴으로 전체 구현 코드 갱신
────────────────────────────────────────
#: 11
이슈: BulkActionConfig 인터페이스 확장
적용 내용: CongestionConfig(4필드), WorkerPoolConfig(7필드) 섹션 추가,
BulkActionRedisConfig extends RedisConfig 구조로 변경,
섹션별 DEFAULT_*_CONFIG 상수 분리 반영
────────────────────────────────────────
#: 12
이슈: Lua 스크립트 네이밍 컨벤션
적용 내용: 파일명 snake_case → kebab-case, 커맨드명 snake_case → camelCase로 수정
────────────────────────────────────────
#: 13
이슈: 테스트 설정 패턴 갱신
적용 내용: BulkActionModule.register() 대신 직접 provider 등록 패턴,
전체 config 섹션 필수 제공, DEFAULT_*_CONFIG 활용,
RedisService/RedisKeyBuilder/LuaScriptLoader 필수 등록, given/when/then 주석 패턴 반영
```
