# Step 3. 혼잡 제어 (Congestion Control)

> 공회전 문제 해결을 위한 동적 대기시간 계산

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [공회전 문제 분석](#공회전-문제-분석)
3. [동적 대기시간 알고리즘](#동적-대기시간-알고리즘)
4. [Redis 데이터 구조 설계](#redis-데이터-구조-설계)
5. [NestJS 모듈 구조](#nestjs-모듈-구조)
6. [구현 코드](#구현-코드)
7. [Step 2 Backpressure와의 연동](#step-2-backpressure와의-연동)
8. [성능 분석](#성능-분석)
9. [테스트 전략](#테스트-전략)
10. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### 혼잡 제어란?

네트워크의 TCP Congestion Control에서 차용한 개념이다. 네트워크에서 패킷 손실이 발생하면 전송 속도를 줄이듯, 벌크액션 시스템에서도 **Rate Limit에 걸린 작업이 많을수록 재시도 간격을 늘려 시스템 부하를 줄인다**.

```
TCP 혼잡 제어 비유:

패킷 손실 감지 → 윈도우 크기 축소 → 전송 속도 감소
      ↕
Rate Limit 거부 → backoff 시간 증가 → 재시도 빈도 감소
```

### Step 2의 한계: 고정 backoff

Step 2에서는 Rate Limit에 걸린 작업을 Non-ready Queue에 넣을 때 **고정 1초 backoff**를 사용한다.

```
고정 backoff 문제:

작업 100개가 Rate Limit에 걸림
→ 100개 모두 1초 후 Ready Queue로 이동
→ 100개가 동시에 Rate Limit 재검사
→ 대부분 다시 Rate Limit에 걸림 (= 공회전)
→ 다시 1초 backoff... 반복
```

이 **공회전(spinning)**은 불필요한 Redis 연산과 CPU 사이클을 소모한다.

### 혼잡 제어가 해결하는 것

| 문제 | 고정 backoff | 동적 backoff (혼잡 제어) |
|------|------------|----------------------|
| 공회전 빈도 | 높음 (수십 회/작업) | 낮음 (평균 1.45회/작업) |
| Redis 불필요 연산 | 매 초마다 대량 ZRANGEBYSCORE | 필요한 시점에만 이동 |
| 처리 지연 | 불필요 재시도로 증가 | 예측 가능한 지연 |
| 시스템 부하 | Rate Limit 검사 폭주 | 점진적 부하 분산 |

---

## 공회전 문제 분석

### 시나리오: 고정 backoff의 공회전

```
시각    이벤트                          Non-ready Queue 크기
──────────────────────────────────────────────────────────────
t=0s    고객사 A에서 1,000건 등록
        Rate Limit: 100 RPS
        → 100건 Ready Queue (허용)
        → 900건 Non-ready Queue (거부, backoff=1s)       900

t=1s    Dispatcher: 900건 → Ready Queue 이동
        Rate Limit 재검사:
        → 100건 허용
        → 800건 다시 Non-ready Queue (backoff=1s)        800

t=2s    Dispatcher: 800건 → Ready Queue 이동
        → 100건 허용
        → 700건 다시 Non-ready Queue                    700

...

t=9s    마지막 100건 처리 완료                              0
```

**문제점:**
- 매 초마다 수백 건이 Non-ready → Ready → Non-ready를 왕복
- 9초 동안 **총 쓰로틀링 횟수: 900+800+700+...+100 = 4,500회**
- 작업당 평균 쓰로틀링: 4,500 / 1,000 = **4.5회**

### 시나리오: 동적 backoff로 개선

```
시각    이벤트                          Non-ready Queue 크기
──────────────────────────────────────────────────────────────
t=0s    고객사 A에서 1,000건 등록
        Rate Limit: 100 RPS
        → 100건 Ready Queue
        → 900건 Non-ready Queue
          backoff = 1s + floor(900/100)*1s = 10s          900

t=1s    Fair Queue에서 새 작업 dequeue → Ready Queue
        Non-ready Queue의 작업은 아직 대기 중              900

...

t=10s   Dispatcher: 900건 backoff 만료 → Ready Queue 이동
        Rate Limit 재검사:
        → 100건 허용
        → 800건 Non-ready Queue
          backoff = 1s + floor(800/100)*1s = 9s           800

t=19s   800건 backoff 만료 → 100건 허용, 700건 재대기
          backoff = 1s + floor(700/100)*1s = 8s           700

...
```

**개선 결과:**
- 작업당 평균 쓰로틀링: **1.45회** (원문 부하 테스트 결과)
- 불필요 Redis 연산 대폭 감소

---

## 동적 대기시간 알고리즘

### 핵심 공식

```
대기시간(ms) = 기본대기(1s) + floor(Non-ready Queue 내 해당 Rate Limit 작업 수 / Rate Limit 속도) × 1s
```

```typescript
function calculateBackoffTime(nonReadyCount: number, rateLimitSpeed: number): number {
  return 1000 + Math.floor(nonReadyCount / rateLimitSpeed) * 1000;
}
```

### 공식 해석

**항 1: `기본대기 (1초)`**

최소 대기시간이다. Rate Limit 윈도우가 1초이므로 최소 1초는 기다려야 새 윈도우에서 재시도할 수 있다.

**항 2: `floor(nonReadyCount / rateLimitSpeed) × 1초`**

Non-ready Queue에 대기 중인 작업을 Rate Limit 속도로 처리하는 데 걸리는 예상 시간이다.

```
예시 1:
  Non-ready Queue: 500건, Rate Limit: 100 RPS
  → 추가 대기 = floor(500/100) × 1s = 5s
  → 총 backoff = 1s + 5s = 6s
  → 해석: "앞에 500건이 있고 초당 100건 처리하니 약 5초 후에 차례가 됨"

예시 2:
  Non-ready Queue: 50건, Rate Limit: 100 RPS
  → 추가 대기 = floor(50/100) × 1s = 0s
  → 총 backoff = 1s + 0s = 1s
  → 해석: "대기 작업이 적으니 1초만 기다리면 됨"

예시 3:
  Non-ready Queue: 10,000건, Rate Limit: 100 RPS
  → 추가 대기 = floor(10000/100) × 1s = 100s
  → 총 backoff = 1s + 100s = 101s
  → 해석: "심각한 혼잡. 101초 후 재시도"
```

### Rate Limit 속도 결정

`rateLimitSpeed`는 해당 그룹이 초당 처리 가능한 작업 수이다.

```
활성 고객사: N개
전체 RPS: G

고객사별 rateLimitSpeed = floor(G / N)

예: G=10,000, N=5 → rateLimitSpeed = 2,000
```

이 값은 Step 2의 `RateLimiterService`에서 계산한 `perGroupLimit`와 동일하다.

### 알고리즘 특성

```
 backoff (초)
    │
 12 ┤                                          ╱
    │                                        ╱
 10 ┤                                      ╱
    │                                    ╱
  8 ┤                                  ╱
    │                                ╱
  6 ┤                              ╱
    │                            ╱
  4 ┤                          ╱
    │                        ╱
  2 ┤──────────────────────╱
    │  (기본 1초)
  1 ┤╱
    └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──► Non-ready 작업 수
       0  1  2  3  4  5  6  7  8  9 10  (×rateLimitSpeed)
```

- **선형 증가**: Non-ready 작업 수에 비례하여 backoff가 선형으로 증가
- **최소 1초**: 혼잡하지 않아도 최소 1개 윈도우만큼 대기
- **계단형**: `floor` 연산으로 같은 RPS 구간 내 작업은 동일한 backoff
- **자기 조절**: 작업이 처리되어 Non-ready Queue가 줄면 backoff도 자동 감소

### TCP 혼잡 제어와의 비교

| 요소 | TCP | 벌크액션 혼잡 제어 |
|------|-----|------------------|
| 혼잡 신호 | 패킷 손실 / ECN | Rate Limit 거부 |
| 제어 변수 | cwnd (전송 윈도우) | backoff time |
| 증가 방식 | Additive Increase | 선형 증가 (Non-ready 비례) |
| 감소 방식 | Multiplicative Decrease | 자동 감소 (큐 비움에 따라) |
| 목표 | 네트워크 대역폭 최대 활용 | Rate Limit 소진 최소화 |

TCP와 다른 점은 **공격적 복구(AIMD)가 아닌 보수적 예측**이라는 것이다. 벌크액션에서는 처리량 극대화보다 **안정성과 공회전 최소화**가 더 중요하다.

---

## Redis 데이터 구조 설계

### 추가 Key 구조

Step 2의 기존 키에 혼잡 제어용 키가 추가된다.

```
# 기존 (Step 2)
bulk-action:non-ready-queue                     # Sorted Set
bulk-action:ready-queue                         # List
bulk-action:rate-limit:{groupId}:{window}       # String
bulk-action:active-groups                       # Set

# 추가 (Step 3)
bulk-action:congestion:{groupId}:non-ready-count   # String - 그룹별 Non-ready 작업 수
bulk-action:congestion:{groupId}:stats             # Hash - 그룹별 혼잡 통계
bulk-action:congestion:{groupId}:history           # List - 혼잡도 히스토리 (시계열 스냅샷)
bulk-action:congestion:{groupId}:completed-count   # String - 그룹별 완료 작업 수 (평균 계산용)
```

### 그룹별 혼잡 통계 (Hash)

모니터링과 backoff 계산에 사용하는 통계 데이터이다.

```
Key: bulk-action:congestion:customer-A:stats
Type: Hash
┌──────────────────────┬────────────────┐
│ field                │ value          │
├──────────────────────┼────────────────┤
│ currentNonReadyCount │ 300            │  ← 현재 Non-ready 작업 수
│ lastBackoffMs        │ 6000           │  ← 마지막 적용된 backoff
│ rateLimitSpeed       │ 100            │  ← 마지막 계산된 그룹별 RPS
│ lastUpdatedMs        │ 1707000000000  │  ← 마지막 갱신 시각 (epoch ms)
│ avgThrottlePerJob    │ 1.45           │  ← 작업당 평균 쓰로틀링 (CongestionStatsService가 갱신)
└──────────────────────┴────────────────┘
```

### ⚠️ ioredis keyPrefix와 Lua 스크립트 키 충돌 주의

ioredis의 `keyPrefix` 옵션을 사용하면, `defineCommand`로 등록된 Lua 스크립트의
KEYS[] 파라미터에 자동으로 접두사가 붙는다. 그런데 Lua 스크립트 **내부에서** `redis.call()`로
키를 직접 구성하면 접두사가 붙지 않아 **이중 접두사** 또는 **접두사 누락** 문제가 발생한다.

```
예: keyPrefix = 'bulk-action:'

KEYS[1]에 'non-ready-queue' 전달
→ ioredis가 자동으로 'bulk-action:non-ready-queue'로 변환 ✅

Lua 내부에서 redis.call('HGET', 'bulk-action:job:' .. jobId, 'groupId')
→ ioredis keyPrefix 미적용 → 'bulk-action:job:xxx' 그대로 사용
→ keyPrefix가 있으면 실제 키는 'bulk-action:bulk-action:job:xxx'가 되어야 할 수도 있음 ⚠️
```

**해결 방법:**

1. Lua 스크립트 내부에서 키를 직접 구성하지 않고, 모든 키를 `KEYS[]`로 전달한다.
2. 불가피하게 내부 구성이 필요하면, `keyPrefix`를 `ARGV[]`로 전달하여 사용한다.
3. `keyPrefix`를 사용하지 않고, 서비스 레이어에서 키 이름에 접두사를 직접 붙인다.

> Step 1의 `dequeue.lua`에서 동일한 이슈가 식별되어 수정된 바 있다.
> `congestion-backoff.lua`는 모든 키를 KEYS[]로 전달받으므로 문제가 없다.
> `move-to-ready.lua`는 congestion 카운터 감소를 위해 내부에서 키를 구성하므로,
> 서비스 레이어에서 `RedisKeyBuilder.getPrefix()`를 ARGV[3]로 전달하는 방식(해결 방법 2)을 채택했다.

### Lua 스크립트: congestion-backoff.lua

Non-ready Queue에 작업을 추가하면서 backoff를 동적으로 계산하는 스크립트이다.

```lua
-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: congestion stats Hash
-- KEYS[3]: congestion non-ready count
-- KEYS[4]: active-groups Set
-- ARGV[1]: jobId
-- ARGV[2]: globalRps
-- ARGV[3]: baseBackoffMs
-- ARGV[4]: maxBackoffMs
-- ARGV[5]: currentTimeMs (Date.now())

-- 1. Increment non-ready count for this group
local nonReadyCount = redis.call('INCR', KEYS[3])

-- 2. Get active group count
local activeGroups = redis.call('SCARD', KEYS[4])
if activeGroups < 1 then
  activeGroups = 1
end

-- 3. Calculate rate limit speed per group
local globalRps = tonumber(ARGV[2])
local rateLimitSpeed = math.max(1, math.floor(globalRps / activeGroups))

-- 4. Calculate dynamic backoff
local baseBackoffMs = tonumber(ARGV[3])
local maxBackoffMs = tonumber(ARGV[4])
local currentTimeMs = tonumber(ARGV[5])

local backoffMs = baseBackoffMs + math.floor(nonReadyCount / rateLimitSpeed) * 1000
if backoffMs > maxBackoffMs then
  backoffMs = maxBackoffMs
end

-- 5. Add job to non-ready queue with calculated execute-at time
local executeAt = currentTimeMs + backoffMs
redis.call('ZADD', KEYS[1], executeAt, ARGV[1])

-- 6. Update congestion stats
redis.call('HSET', KEYS[2],
  'currentNonReadyCount', tostring(nonReadyCount),
  'lastBackoffMs', tostring(backoffMs),
  'rateLimitSpeed', tostring(rateLimitSpeed),
  'lastUpdatedMs', tostring(currentTimeMs)
)

return {backoffMs, nonReadyCount, rateLimitSpeed}
```

> **설계 변경 사항 (구현 시 반영):**
> - `groupId`를 ARGV에서 제거: 서비스 레이어에서 그룹별 키를 KEYS[]로 분리 전달하므로 Lua 내부에서 groupId가 불필요.
> - `redis.call('TIME')` → `Date.now()` ARGV 전달: Redis TIME 명령 대신 서비스 레이어에서 현재 시각을 전달하여 테스트 가능성 향상.
> - `HINCRBY totalThrottleCount` 제거: 누적 쓰로틀링 횟수는 `CongestionStatsService`에서 별도 관리.

### Lua 스크립트: congestion-release.lua

Non-ready Queue에서 작업이 빠져나갈 때 카운트를 감소시키는 스크립트이다.

```lua
-- KEYS[1]: congestion non-ready count
-- KEYS[2]: congestion stats Hash
-- ARGV[1]: decreaseCount

local decreaseCount = tonumber(ARGV[1])
local newCount = redis.call('DECRBY', KEYS[1], decreaseCount)

if newCount < 0 then
  newCount = 0
  redis.call('SET', KEYS[1], '0')
end

redis.call('HSET', KEYS[2], 'currentNonReadyCount', tostring(newCount))

return newCount
```

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/
├── src/
│   ├── congestion/
│   │   ├── BackoffCalculator.ts              # backoff 계산 유틸리티 + CongestionLevel enum
│   │   ├── CongestionControlService.ts       # 혼잡 제어 핵심 서비스
│   │   └── CongestionStatsService.ts         # 혼잡 통계 조회/관리
│   ├── config/
│   │   └── BulkActionConfig.ts               # congestion 설정 포함
│   ├── key/
│   │   └── RedisKeyBuilder.ts                # congestion 키 빌더 메서드 포함
│   └── lua/
│       ├── congestion-backoff.lua            # 동적 backoff + Non-ready 추가
│       ├── congestion-release.lua            # Non-ready 카운트 감소
│       ├── move-to-ready.lua                 # Dispatcher용 (congestion 카운터 감소 통합)
│       └── LuaScriptLoader.ts               # Lua 스크립트 등록
└── test/
    └── congestion/
        ├── BackoffCalculator.spec.ts         # 계산기 단위 테스트
        └── CongestionControlService.spec.ts  # 통합 테스트 (실제 Redis)
```

### 설정 확장

**`config/BulkActionConfig.ts`**

각 섹션별 인터페이스와 기본값이 분리되어 있으며, `BulkActionModule.register()`에서 deep merge된다.

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
  globalRps: number;
  readyQueueMaxSize: number;
  rateLimitWindowSec: number;
  rateLimitKeyTtlSec: number;
  dispatchIntervalMs: number;
  dispatchBatchSize: number;
  defaultBackoffMs: number;
  maxBackoffMs: number;
}

export interface CongestionConfig {
  enabled: boolean;              // 혼잡 제어 활성화 여부 (default: true)
  baseBackoffMs: number;         // 기본 backoff (default: 1000)
  maxBackoffMs: number;          // 최대 backoff 상한 (default: 120000)
  statsRetentionMs: number;      // 통계 보관 기간 (default: 3600000 = 1시간)
}

export interface WorkerPoolConfig {
  workerCount: number;
  fetchIntervalMs: number;
  fetchBatchSize: number;
  workerTimeoutSec: number;
  jobTimeoutMs: number;
  maxRetryCount: number;
  shutdownGracePeriodMs: number;
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;
}

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

> **구현 변경 사항:**
> - `redis` 타입이 `RedisConfig`를 확장하는 `BulkActionRedisConfig`로 변경 (공용 Redis 설정 재사용).
> - 기본값이 `DEFAULT_BULK_ACTION_CONFIG` 단일 객체가 아닌 섹션별 상수(`DEFAULT_CONGESTION_CONFIG`, `DEFAULT_WORKER_POOL_CONFIG` 등)로 분리.
> - Step 4 구현에 따라 `workerPool` 섹션 추가.

---

## 구현 코드

### Backoff Calculator

**`congestion/BackoffCalculator.ts`**

```typescript
export enum CongestionLevel {
  NONE = 'NONE',         // backoff = base (혼잡 없음)
  LOW = 'LOW',           // backoff < base * 3
  MODERATE = 'MODERATE', // backoff < base * 10
  HIGH = 'HIGH',         // backoff < base * 30
  CRITICAL = 'CRITICAL', // backoff >= base * 30
}

export interface BackoffParams {
  nonReadyCount: number;     // 그룹의 Non-ready Queue 작업 수
  rateLimitSpeed: number;    // 그룹의 초당 처리 가능 수 (perGroupLimit)
  baseBackoffMs: number;     // 기본 backoff (ms)
  maxBackoffMs: number;      // 최대 backoff 상한 (ms)
}

export interface BackoffResult {
  backoffMs: number;         // 계산된 backoff (ms)
  nonReadyCount: number;     // 현재 Non-ready 작업 수
  rateLimitSpeed: number;    // 적용된 그룹별 RPS
  congestionLevel: CongestionLevel;
}

export class BackoffCalculator {
  static calculate(params: BackoffParams): BackoffResult {
    const { nonReadyCount, rateLimitSpeed, baseBackoffMs, maxBackoffMs } = params;
    const safeSpeed = Math.max(1, rateLimitSpeed);

    const backoffMs = Math.min(
      baseBackoffMs + Math.floor(nonReadyCount / safeSpeed) * 1000,
      maxBackoffMs,
    );

    return {
      backoffMs,
      nonReadyCount,
      rateLimitSpeed: safeSpeed,
      congestionLevel: BackoffCalculator.classify(backoffMs, baseBackoffMs),
    };
  }

  static classify(backoffMs: number, baseBackoffMs: number): CongestionLevel {
    if (baseBackoffMs <= 0) {
      return CongestionLevel.NONE;
    }

    const ratio = backoffMs / baseBackoffMs;

    if (ratio <= 1) return CongestionLevel.NONE;
    if (ratio < 3) return CongestionLevel.LOW;
    if (ratio < 10) return CongestionLevel.MODERATE;
    if (ratio < 30) return CongestionLevel.HIGH;
    return CongestionLevel.CRITICAL;
  }

  static estimateCompletionTime(
    nonReadyCount: number,
    rateLimitSpeed: number,
  ): number {
    const safeSpeed = Math.max(1, rateLimitSpeed);
    return Math.ceil(nonReadyCount / safeSpeed) * 1000;
  }
}
```

> **구현 변경 사항:**
> - `BackoffResult`에서 `estimatedWaitSec` 제거, `nonReadyCount`/`rateLimitSpeed` 추가 — Lua 결과를 그대로 전달하는 구조.
> - `classify()`가 `baseBackoffMs <= 0` 방어 로직 추가.
> - `estimateCompletionTime()`이 객체 파라미터 대신 positional 파라미터로 단순화, 반환값도 `number`(ms)로 변경.

### Congestion Control Service

**`congestion/CongestionControlService.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import {
  BackoffCalculator,
  BackoffResult,
  CongestionLevel,
} from './BackoffCalculator';

export interface GroupCongestionState {
  groupId: string;
  nonReadyCount: number;
  rateLimitSpeed: number;
  lastBackoffMs: number;
  congestionLevel: CongestionLevel;
}

export interface SystemCongestionSummary {
  totalNonReadyCount: number;
  activeGroupCount: number;
  groups: GroupCongestionState[];
}

@Injectable()
export class CongestionControlService {
  private readonly logger = new Logger(CongestionControlService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async addToNonReady(jobId: string, groupId: string): Promise<BackoffResult> {
    if (!this.config.congestion.enabled) {
      return this.fixedBackoff(jobId, groupId);
    }

    try {
      const result = (await this.redisService.callCommand(
        'congestionBackoff',
        [
          this.keys.nonReadyQueue(),
          this.keys.congestionStats(groupId),
          this.keys.congestionNonReadyCount(groupId),
          this.keys.activeGroups(),
        ],
        [
          jobId,
          this.config.backpressure.globalRps.toString(),
          this.config.congestion.baseBackoffMs.toString(),
          this.config.congestion.maxBackoffMs.toString(),
          Date.now().toString(),
        ],
      )) as number[];

      const backoffResult = BackoffCalculator.calculate({
        nonReadyCount: result[1],
        rateLimitSpeed: result[2],
        baseBackoffMs: this.config.congestion.baseBackoffMs,
        maxBackoffMs: this.config.congestion.maxBackoffMs,
      });

      this.logger.debug(
        `Job ${jobId} -> Non-ready (group=${groupId}, backoff=${backoffResult.backoffMs}ms, ` +
          `level=${backoffResult.congestionLevel}, count=${backoffResult.nonReadyCount})`,
      );

      return backoffResult;
    } catch (error) {
      this.logger.error(
        `Congestion backoff failed for ${jobId}, falling back to fixed: ${
          (error as Error).message
        }`,
      );

      return this.fixedBackoff(jobId, groupId);
    }
  }

  async releaseFromNonReady(groupId: string, count: number): Promise<number> {
    try {
      const result = await this.redisService.callCommand(
        'congestionRelease',
        [
          this.keys.congestionNonReadyCount(groupId),
          this.keys.congestionStats(groupId),
        ],
        [count.toString()],
      );

      return result as number;
    } catch (error) {
      this.logger.error(
        `Congestion release failed for ${groupId}: ${(error as Error).message}`,
      );

      return 0;
    }
  }

  async getCongestionState(groupId: string): Promise<GroupCongestionState> {
    const [countRaw, stats, activeGroupCount] = await Promise.all([
      this.redisService.string.get(this.keys.congestionNonReadyCount(groupId)),
      this.redisService.hash.getAll(this.keys.congestionStats(groupId)),
      this.redisService.set.size(this.keys.activeGroups()),
    ]);

    const nonReadyCount = parseInt(countRaw ?? '0', 10);
    const rateLimitSpeed = Math.max(
      1,
      Math.floor(
        this.config.backpressure.globalRps / Math.max(1, activeGroupCount),
      ),
    );
    const lastBackoffMs = parseInt(stats.lastBackoffMs ?? '0', 10);

    return {
      groupId,
      nonReadyCount,
      rateLimitSpeed,
      lastBackoffMs,
      congestionLevel: BackoffCalculator.classify(
        lastBackoffMs,
        this.config.congestion.baseBackoffMs,
      ),
    };
  }

  async getSystemCongestionSummary(): Promise<SystemCongestionSummary> {
    const groupIds = await this.redisService.set.members(
      this.keys.activeGroups(),
    );

    const groups = await Promise.all(
      groupIds.map(async (groupId) => this.getCongestionState(groupId)),
    );

    const totalNonReadyCount = groups.reduce(
      (sum, g) => sum + g.nonReadyCount,
      0,
    );

    return {
      totalNonReadyCount,
      activeGroupCount: groupIds.length,
      groups,
    };
  }

  async resetGroupStats(groupId: string): Promise<void> {
    await this.redisService.delete(
      this.keys.congestionNonReadyCount(groupId),
      this.keys.congestionStats(groupId),
    );
  }

  private async fixedBackoff(
    jobId: string,
    groupId: string,
  ): Promise<BackoffResult> {
    const backoffMs = this.config.congestion.baseBackoffMs;
    const executeAt = Date.now() + backoffMs;

    await this.redisService.sortedSet.add(
      this.keys.nonReadyQueue(),
      executeAt,
      jobId,
    );

    this.logger.debug(
      `Job ${jobId} -> Non-ready fixed backoff (group=${groupId}, backoff=${backoffMs}ms)`,
    );

    return {
      backoffMs,
      nonReadyCount: 0,
      rateLimitSpeed: 0,
      congestionLevel: CongestionLevel.NONE,
    };
  }
}
```

> **구현 변경 사항:**
> - DI: `ioredis` 직접 주입 대신 `RedisService` 래퍼 + `RedisKeyBuilder` 사용. 키를 하드코딩하지 않고 `keys.*()` 메서드로 생성.
> - `Lua 호출`: `(redis as any).congestion_backoff()` 대신 `redisService.callCommand('congestionBackoff', KEYS, ARGV)` 패턴.
> - `GroupCongestionState`: `currentBackoffMs` → `lastBackoffMs`, `totalThrottleCount`/`lastThrottleAt`/`avgThrottlePerJob` 필드 제거 (stats Hash에서 직접 관리).
> - `SystemCongestionSummary`: `worstCongestionLevel`/`worstCongestionGroupId` 제거, `groups` 배열로 단순화.
> - `fixedBackoff()`: 반환값에 `nonReadyCount: 0`, `rateLimitSpeed: 0` 추가 (BackoffResult 인터페이스 변경 반영).
> - `logCongestionState()` 제거: 단일 `logger.debug()` 호출로 대체.

### Congestion Stats Service

**`congestion/CongestionStatsService.ts`**

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface CongestionSnapshot {
  nonReadyCount: number;
  rateLimitSpeed: number;
  backoffMs: number;
  timestamp: number;
}

@Injectable()
export class CongestionStatsService {
  private readonly maxHistoryLength: number;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {
    this.maxHistoryLength = Math.floor(
      this.config.congestion.statsRetentionMs / 1000,
    );
  }

  /**
   * 작업 완료 시 해당 그룹의 평균 쓰로틀링 횟수를 갱신한다.
   * 증분 평균(incremental mean) 공식: newAvg = prevAvg + (throttleCount - prevAvg) / completed
   */
  async recordJobCompletion(
    groupId: string,
    throttleCount: number,
  ): Promise<void> {
    const completedKey = this.keys.congestionCompletedCount(groupId);
    const statsKey = this.keys.congestionStats(groupId);

    await this.redisService.string.increment(completedKey);

    const completedRaw = await this.redisService.string.get(completedKey);
    const completed = parseInt(completedRaw ?? '1', 10);
    const prevAvgRaw = await this.redisService.hash.get(
      statsKey,
      'avgThrottlePerJob',
    );
    const prevAvg = parseFloat(prevAvgRaw ?? '0');

    const newAvg = prevAvg + (throttleCount - prevAvg) / completed;
    await this.redisService.hash.set(
      statsKey,
      'avgThrottlePerJob',
      newAvg.toFixed(2),
    );
  }

  async snapshotCongestion(
    groupId: string,
    snapshot: CongestionSnapshot,
  ): Promise<void> {
    const historyKey = this.keys.congestionHistory(groupId);

    await this.redisService.list.append(historyKey, JSON.stringify(snapshot));
    await this.redisService.list.trim(historyKey, -this.maxHistoryLength, -1);
  }

  async getCongestionHistory(
    groupId: string,
    limit: number,
  ): Promise<CongestionSnapshot[]> {
    const historyKey = this.keys.congestionHistory(groupId);
    const entries = await this.redisService.list.range(historyKey, -limit, -1);

    return entries.map((entry) => JSON.parse(entry) as CongestionSnapshot);
  }
}
```

> **구현 변경 사항:**
> - DI: `ioredis` 직접 주입 대신 `RedisService` + `RedisKeyBuilder` 사용.
> - `Logger` 제거: 현재 구현에서 로깅 없음.
> - `recordJobCompletion()`: 단순 나눗셈(`totalThrottles / completed`) 대신 증분 평균 공식 사용 — `totalThrottleCount` Hash 필드에 의존하지 않음.
> - `snapshotCongestion()`: snapshot 파라미터가 `CongestionSnapshot` 인터페이스로 타입 명시. `maxHistoryLength`를 constructor에서 사전 계산.
> - `getCongestionHistory()`: `limit` 파라미터의 기본값 제거 (호출자가 명시).

---

## Step 2 Backpressure와의 연동

### Step 2 → Step 3 서비스 교체 가이드

Step 3 적용 시 Step 2의 `NonReadyQueueService.push()`가 `CongestionControlService.addToNonReady()`로 교체된다.
두 서비스의 역할을 명확히 구분하여 중복 호출을 방지해야 한다.

| 역할 | Step 2 (교체 전) | Step 3 (교체 후) |
|------|-----------------|-----------------|
| Non-ready Queue 추가 | `NonReadyQueueService.push(jobId, fixedBackoff)` | `CongestionControlService.addToNonReady(jobId, groupId)` |
| backoff 계산 | 고정 1초 (`defaultBackoffMs`) | 동적 계산 (Lua `congestion_backoff.lua`) |
| Non-ready 카운트 관리 | 없음 | `congestion:{groupId}:non-ready-count` INCR/DECR |
| 혼잡 통계 갱신 | 없음 | `congestion:{groupId}:stats` Hash 갱신 |

> **주의:** Step 3 적용 후에는 `NonReadyQueueService.push()`를 직접 호출하지 않는다.
> `CongestionControlService.addToNonReady()`가 내부적으로 Non-ready Queue에 ZADD를 수행하므로,
> 양쪽을 모두 호출하면 **이중 등록** 및 **카운트 불일치**가 발생한다.
>
> `NonReadyQueueService`는 Step 3 이후 **읽기 전용**(popReady, ZRANGEBYSCORE 등)으로만 사용하거나,
> `CongestionControlService`에 위임하는 래퍼로 변경한다.

### 변경 지점: BackpressureService.admit()

Step 2의 `BackpressureService`에서 고정 backoff를 사용하던 부분을 `CongestionControlService`로 교체한다.

**변경 전 (Step 2):**

```typescript
// backpressure.service.ts - Step 2
private calculateBackoff(groupId: string): number {
  // 고정 1초 backoff
  return 1000;
}
```

**변경 후 (Step 3):**

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

    // ★ 변경: 고정 backoff → 동적 backoff (혼잡 제어)
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

> **구현 변경 사항:**
> - `NonReadyQueueService` 의존 제거: `CongestionControlService`가 Non-ready Queue ZADD를 내부 처리하므로 불필요.
> - `reason` 문자열: Rate Limit 상세 정보 (`globalCount/globalLimit`, `groupCount/perGroupLimit`) 포함.
> - `requeue()`: `retryCount` → `_retryCount` (현재 미사용, 향후 지수 backoff 확장 여지).

### 변경 지점: DispatcherService

Dispatcher가 Non-ready → Ready 이동 시 **`move-to-ready.lua` 내부에서 congestion 카운터를 원자적으로 감소**시킨다.
`CongestionControlService`를 직접 주입하지 않으며, Lua 스크립트에 `prefix`를 전달하여 congestion 키에 접근한다.

```typescript
@Injectable()
export class DispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private state: DispatcherState = DispatcherState.IDLE;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly readyQueue: ReadyQueueService,
  ) {}

  // ... start(), stop(), getState(), getStats() 생략

  private async dispatch(): Promise<number> {
    if (this.isRunning) {
      return 0;
    }
    this.isRunning = true;

    try {
      const hasCapacity = await this.readyQueue.hasCapacity();

      if (!hasCapacity) {
        this.logger.debug('Ready Queue full, skipping dispatch');

        return 0;
      }

      const moved = await this.moveToReady();

      if (moved > 0) {
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
   * move-to-ready.lua에 prefix를 ARGV[3]로 전달하여,
   * Lua 내부에서 job metadata Hash → groupId 조회 → congestion 카운터 DECR을
   * 원자적으로 처리한다.
   */
  private async moveToReady(): Promise<number> {
    const result = await this.redisService.callCommand(
      'moveToReady',
      [this.keys.nonReadyQueue(), this.keys.readyQueue()],
      [
        Date.now().toString(),
        this.config.backpressure.dispatchBatchSize.toString(),
        this.keys.getPrefix(),  // ★ congestion 카운터 감소에 사용
      ],
    );

    return result as number;
  }
}
```

#### move-to-ready.lua (congestion 카운터 감소 통합)

```lua
-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- ARGV[1]: current time (epoch ms)
-- ARGV[2]: max batch size
-- ARGV[3]: key prefix (optional, for congestion counter decrement)

local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #jobs == 0 then
  return 0
end

local prefix = ARGV[3]

for _, jobId in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('RPUSH', KEYS[2], jobId)

  if prefix then
    local jobKey = prefix .. 'job:' .. jobId
    local groupId = redis.call('HGET', jobKey, 'groupId')
    if groupId then
      local countKey = prefix .. 'congestion:' .. groupId .. ':non-ready-count'
      local newCount = redis.call('DECR', countKey)
      if newCount < 0 then
        redis.call('SET', countKey, '0')
      end
      local statsKey = prefix .. 'congestion:' .. groupId .. ':stats'
      redis.call('HSET', statsKey, 'currentNonReadyCount', tostring(math.max(0, newCount)))
    end
  end
end

return #jobs
```

> **구현 결정 사항:**
> - 문서 초안에서 "권장 방법 3 (Lua 스크립트 내 처리)"로 제안했던 것이 실제로 채택됨.
> - `CongestionControlService` 직접 주입 제거: Dispatcher는 `RedisService`, `RedisKeyBuilder`, `ReadyQueueService`만 의존.
> - `updateCongestionCounters()` 메서드 제거: Lua 내부에서 원자적 처리.
> - `prefix`가 있을 때만 congestion 카운터를 갱신하므로, congestion 모듈 미사용 시에도 안전.

### 전체 데이터 흐름 (Step 1 + 2 + 3)

```
┌─────────────────────────────────────────────────────────────────┐
│ Fetcher                                                         │
│                                                                 │
│ 1. fairQueue.dequeue()                     ← Step 1             │
│ 2. rateLimiter.checkRateLimit(groupId)     ← Step 2             │
│    │                                                            │
│    ├── allowed → readyQueue.push(jobId)    ← Step 2             │
│    │                                                            │
│    └── denied  → congestionControl         ← Step 3 ★          │
│                   .addToNonReady(jobId, groupId)                │
│                   │                                             │
│                   ├── Non-ready 카운트 증가                      │
│                   ├── 동적 backoff 계산                          │
│                   │   (nonReadyCount / rateLimitSpeed)           │
│                   ├── Non-ready Queue에 추가 (score=now+backoff) │
│                   └── 혼잡 통계 갱신                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Dispatcher (주기적 실행) — move-to-ready.lua                      │
│                                                                 │
│ 1. Non-ready Queue에서 score <= now 작업 조회                     │
│ 2. Ready Queue로 이동 (ZREM + RPUSH)                             │
│ 3. prefix가 있으면 Lua 내부에서:                  ← Step 3 ★      │
│    ├── HGET {prefix}job:{jobId} groupId                         │
│    ├── DECR {prefix}congestion:{groupId}:non-ready-count        │
│    └── HSET stats currentNonReadyCount 동기화                    │
│    → 원자적으로 congestion 카운터 감소                              │
│    → 이후 같은 그룹 작업의 backoff가 자동으로 줄어듦                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 성능 분석

### 원문 부하 테스트 결과

채널톡 원문에서 15,000개 작업, 10TPS 조건의 부하 테스트 결과:

| 지표 | 고정 backoff | 동적 backoff (혼잡 제어) |
|------|------------|----------------------|
| 이상적 처리 시간 | 500초 | 500초 |
| 실제 처리 시간 | 측정 불가 (공회전 과다) | ~720초 |
| 오차 | - | +44% |
| 작업당 평균 쓰로틀링 | 수십 회 | 1.45회 |
| Redis 불필요 연산 | 매우 높음 | 최소화 |

### +44% 오차의 원인

이상적 시간(500초)과 실제 시간(720초)의 차이는 다음에서 발생한다:

```
1. 초기 과도기 (Initial Transient)
   - 첫 번째 윈도우에서 대량 작업이 Non-ready로 밀림
   - 첫 backoff 원시값 = 1s + floor(14,900/10) × 1s = 1,491초
   - maxBackoffMs(120초) 상한 적용 → 실제 backoff = 120초
   - 이후 Non-ready 카운트가 줄어들 때까지 모든 작업이 maxBackoff(120초)로 클램핑됨
   → 초기 ~120초 구간에서 작업 소화가 지연되어 전체 처리 시간이 늘어남

2. 계단형 backoff의 비효율
   - floor() 연산으로 정확한 도착 시각 대신 근사값 사용
   - 같은 구간 내 작업이 동시 도착 → 미니 burst 발생

3. Dispatcher 주기 오버헤드
   - 100ms 주기로 스캔 → 실제 이동 시각이 backoff 만료 후 최대 100ms 지연
```

### 시뮬레이션: 동적 backoff 효과

```
조건: 1,000개 작업, 100 RPS, 고정 backoff vs 동적 backoff

고정 backoff (1초):
┌─────┬─────────────┬────────────┬──────────────┐
│초   │ Ready Queue │ Non-ready  │ 쓰로틀링 횟수  │
├─────┼─────────────┼────────────┼──────────────┤
│ 0   │ 100         │ 900        │ 900          │
│ 1   │ 100         │ 800        │ 800          │
│ 2   │ 100         │ 700        │ 700          │
│ ... │ ...         │ ...        │ ...          │
│ 9   │ 100         │ 0          │ 0            │
│합계 │             │            │ 4,500회       │
└─────┴─────────────┴────────────┴──────────────┘
작업당 평균: 4.5회

동적 backoff:
┌─────┬─────────────┬────────────┬──────────────┬─────────┐
│초   │ Ready Queue │ Non-ready  │ 쓰로틀링 횟수  │ backoff │
├─────┼─────────────┼────────────┼──────────────┼─────────┤
│ 0   │ 100         │ 900        │ 900          │ 10초    │
│ 10  │ 100         │ 800*       │ ~100         │ 9초     │
│ 19  │ 100         │ 700*       │ ~100         │ 8초     │
│ ... │ ...         │ ...        │ ...          │ ...     │
│합계 │             │            │ ~1,450회      │         │
└─────┴─────────────┴────────────┴──────────────┴─────────┘
작업당 평균: ~1.45회

* Non-ready에서 돌아온 작업 중 Rate Limit 통과 못한 것만 재진입
```

---

## 테스트 전략

### BackoffCalculator 단위 테스트

**`test/congestion/BackoffCalculator.spec.ts`**

```typescript
import {
  BackoffCalculator,
  CongestionLevel,
} from '@app/bulk-action/congestion/BackoffCalculator';

describe('BackoffCalculator', () => {
  describe('calculate', () => {
    it('첫 번째 작업은 base backoff를 반환한다', () => {
      // given
      const params = {
        nonReadyCount: 1,
        rateLimitSpeed: 10,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);
    });

    it('non-ready 수에 비례하여 backoff가 증가한다', () => {
      // given - nonReadyCount=20, rateLimitSpeed=10
      // backoff = 1000 + floor(20/10) * 1000 = 3000ms
      const params = {
        nonReadyCount: 20,
        rateLimitSpeed: 10,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(3000);
    });

    it('maxBackoffMs로 클램핑된다', () => {
      // given
      const params = {
        nonReadyCount: 10000,
        rateLimitSpeed: 1,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(120000);
    });

    it('rateLimitSpeed가 0이면 1로 보정된다', () => {
      // given
      const params = {
        nonReadyCount: 5,
        rateLimitSpeed: 0,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.rateLimitSpeed).toBe(1);
      expect(result.backoffMs).toBe(6000);
    });
  });

  describe('classify', () => {
    it.each([
      { backoffMs: 1000, baseBackoffMs: 1000, expected: CongestionLevel.NONE },
      { backoffMs: 2000, baseBackoffMs: 1000, expected: CongestionLevel.LOW },
      { backoffMs: 2999, baseBackoffMs: 1000, expected: CongestionLevel.LOW },
      { backoffMs: 3000, baseBackoffMs: 1000, expected: CongestionLevel.MODERATE },
      { backoffMs: 9999, baseBackoffMs: 1000, expected: CongestionLevel.MODERATE },
      { backoffMs: 10000, baseBackoffMs: 1000, expected: CongestionLevel.HIGH },
      { backoffMs: 29999, baseBackoffMs: 1000, expected: CongestionLevel.HIGH },
      { backoffMs: 30000, baseBackoffMs: 1000, expected: CongestionLevel.CRITICAL },
      { backoffMs: 120000, baseBackoffMs: 1000, expected: CongestionLevel.CRITICAL },
    ])(
      'backoff=$backoffMs, base=$baseBackoffMs → $expected',
      ({ backoffMs, baseBackoffMs, expected }) => {
        // when
        const result = BackoffCalculator.classify(backoffMs, baseBackoffMs);

        // then
        expect(result).toBe(expected);
      },
    );

    it('baseBackoffMs가 0이면 NONE을 반환한다', () => {
      // when
      const result = BackoffCalculator.classify(5000, 0);

      // then
      expect(result).toBe(CongestionLevel.NONE);
    });
  });

  describe('estimateCompletionTime', () => {
    it('대기 중인 작업 수와 처리 속도로 완료 시간을 추정한다', () => {
      // given - 100개 대기, 속도 10/s
      // when
      const result = BackoffCalculator.estimateCompletionTime(100, 10);

      // then - ceil(100/10) * 1000 = 10000ms
      expect(result).toBe(10000);
    });

    it('rateLimitSpeed가 0이면 1로 보정된다', () => {
      const result = BackoffCalculator.estimateCompletionTime(5, 0);
      expect(result).toBe(5000);
    });

    it('나누어 떨어지지 않으면 올림한다', () => {
      // ceil(15/10) * 1000 = 2000
      const result = BackoffCalculator.estimateCompletionTime(15, 10);
      expect(result).toBe(2000);
    });
  });
});
```

### CongestionControlService 통합 테스트

**`test/congestion/CongestionControlService.spec.ts`**

실제 Redis를 사용하는 통합 테스트. `beforeEach`에서 `flushDatabase` 후 `active-groups`에 테스트 그룹을 등록한다.

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
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { CongestionControlService } from '@app/bulk-action/congestion/CongestionControlService';
import { CongestionLevel } from '@app/bulk-action/congestion/BackoffCalculator';

describe('CongestionControlService', () => {
  let module: TestingModule;
  let service: CongestionControlService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

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
      ...DEFAULT_BACKPRESSURE_CONFIG,
      globalRps: 10,
    },
    congestion: {
      enabled: true,
      baseBackoffMs: 1000,
      maxBackoffMs: 120000,
      statsRetentionMs: 3600000,
    },
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
        CongestionControlService,
      ],
    }).compile();

    await module.init();
    service = module.get(CongestionControlService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
    await redisService.set.add(keys.activeGroups(), 'customer-A');
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('addToNonReady', () => {
    it('첫 번째 작업은 base backoff를 받는다', async () => {
      // when
      const result = await service.addToNonReady('job-1', 'customer-A');

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.nonReadyCount).toBe(1);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);
    });

    it('작업이 쌓이면 backoff가 증가한다', async () => {
      // given - 10개 작업 추가 (rateLimitSpeed = globalRps/1group = 10)
      for (let i = 0; i < 10; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 11번째
      const result = await service.addToNonReady('job-10', 'customer-A');

      // then - backoff = 1000 + floor(11/10) * 1000 = 2000
      expect(result.backoffMs).toBe(2000);
      expect(result.nonReadyCount).toBe(11);
    });

    it('여러 활성 그룹이 있으면 rateLimitSpeed가 줄어들어 backoff가 증가한다', async () => {
      // given - 2개 그룹
      await redisService.set.add(keys.activeGroups(), 'customer-B');

      // rateLimitSpeed = floor(10/2) = 5
      for (let i = 0; i < 5; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 6번째
      const result = await service.addToNonReady('job-5', 'customer-A');

      // then - backoff = 1000 + floor(6/5) * 1000 = 2000
      expect(result.backoffMs).toBe(2000);
      expect(result.rateLimitSpeed).toBe(5);
    });
  });

  describe('releaseFromNonReady', () => {
    it('카운터를 감소시킨다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');
      await service.addToNonReady('job-3', 'customer-A');

      // when
      const newCount = await service.releaseFromNonReady('customer-A', 2);

      // then
      expect(newCount).toBe(1);
    });

    it('카운터 감소 후 추가하면 backoff가 줄어든다', async () => {
      // given - 20개 작업
      for (let i = 0; i < 20; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 10개 해제 후 추가
      await service.releaseFromNonReady('customer-A', 10);
      const result = await service.addToNonReady('job-20', 'customer-A');

      // then - nonReadyCount = 10 + 1 = 11, backoff = 1000 + floor(11/10)*1000 = 2000
      expect(result.nonReadyCount).toBe(11);
      expect(result.backoffMs).toBe(2000);
    });
  });

  describe('getCongestionState', () => {
    it('그룹의 혼잡 상태를 조회한다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');

      // when
      const state = await service.getCongestionState('customer-A');

      // then
      expect(state.groupId).toBe('customer-A');
      expect(state.nonReadyCount).toBe(2);
      expect(state.rateLimitSpeed).toBe(10);
      expect(state.lastBackoffMs).toBe(1000);
    });
  });

  describe('getSystemCongestionSummary', () => {
    it('전체 시스템 혼잡 요약을 반환한다', async () => {
      // given
      await redisService.set.add(keys.activeGroups(), 'customer-B');
      await service.addToNonReady('job-A1', 'customer-A');
      await service.addToNonReady('job-B1', 'customer-B');

      // when
      const summary = await service.getSystemCongestionSummary();

      // then
      expect(summary.activeGroupCount).toBe(2);
      expect(summary.totalNonReadyCount).toBe(2);
      expect(summary.groups).toHaveLength(2);
    });
  });

  describe('resetGroupStats', () => {
    it('그룹의 혼잡 통계를 초기화한다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');

      // when
      await service.resetGroupStats('customer-A');

      // then
      const state = await service.getCongestionState('customer-A');
      expect(state.nonReadyCount).toBe(0);
      expect(state.lastBackoffMs).toBe(0);
    });
  });

  describe('disabled mode', () => {
    it('disabled일 때 고정 backoff로 폴백한다', async () => {
      // given - disabled config로 새 모듈 생성
      const disabledConfig: BulkActionConfig = {
        ...config,
        congestion: { ...config.congestion, enabled: false },
      };

      const disabledModule = await Test.createTestingModule({
        imports: [
          RedisModule.register({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
          }),
        ],
        providers: [
          { provide: BULK_ACTION_CONFIG, useValue: disabledConfig },
          RedisKeyBuilder,
          LuaScriptLoader,
          CongestionControlService,
        ],
      }).compile();

      await disabledModule.init();
      const disabledService = disabledModule.get(CongestionControlService);

      // when
      const result = await disabledService.addToNonReady('job-1', 'customer-A');

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);

      await disabledModule.close();
    });
  });
});
```

---

## 운영 고려사항

### 모니터링 지표

```
# 혼잡도 레벨 분포
bulk_action_congestion_level{groupId="...", level="NONE|LOW|MODERATE|HIGH|CRITICAL"}

# 동적 backoff 값 분포
bulk_action_congestion_backoff_ms{groupId="..."}  (histogram)

# 작업당 평균 쓰로틀링 횟수
bulk_action_congestion_avg_throttle_per_job{groupId="..."}

# 그룹별 Non-ready 작업 수
bulk_action_congestion_non_ready_count{groupId="..."}

# 혼잡 제어로 절약된 공회전 횟수 (추정)
bulk_action_congestion_saved_spins_total
```

### 알림 조건

| 조건 | 심각도 | 대응 |
|------|-------|------|
| `congestionLevel == CRITICAL` 5분 이상 지속 | Critical | globalRps 확인, Worker 상태 점검 |
| `avgThrottlePerJob > 5` | Warning | Rate Limit 설정 검토 |
| `nonReadyCount` 지속 증가 | Warning | 처리 속도 < 유입 속도. Worker 증설 검토 |
| `backoffMs == maxBackoffMs` 빈발 | Warning | maxBackoffMs 상향 또는 근본 원인 제거 |

### 설정 튜닝 가이드

| 설정 | 기본값 | 조정 기준 |
|------|-------|----------|
| `congestion.enabled` | true | 장애 시 false로 전환하여 고정 backoff 폴백 |
| `congestion.baseBackoffMs` | 1,000 | Rate Limit 윈도우와 동일하게 유지 |
| `congestion.maxBackoffMs` | 120,000 | 작업의 최대 허용 지연시간. SLA 기반 설정 |
| `congestion.statsRetentionMs` | 3,600,000 | 통계 보관 기간. 디스크 대신 Redis이므로 메모리 고려 |

### 엣지 케이스 처리

**1) 활성 그룹 수 급변**

고객사가 대량으로 추가/완료되면 `rateLimitSpeed`가 급격히 변한다.

```
시각 t: 그룹 2개, rateLimitSpeed = 5000
시각 t+1: 그룹 100개 추가, rateLimitSpeed = 100
→ 기존 작업의 backoff가 갑자기 부족해짐 (과소 계산)
```

대응: backoff는 Non-ready Queue 진입 시점에 계산되므로, 이미 큐에 있는 작업은 영향받지 않는다. 새로 진입하는 작업부터 새 rateLimitSpeed가 적용된다.

**2) Non-ready 카운트 불일치**

Redis 장애나 네트워크 지연으로 카운트가 실제와 불일치할 수 있다.

```
대응:
- 주기적 보정: Dispatcher가 ZCARD로 실제 Non-ready Queue 크기를 확인하여 카운트 보정
- 최대 backoff 상한으로 과도한 지연 방지
```

**3) 혼잡 제어 비활성화 전환**

운영 중 혼잡 제어를 끄면 Non-ready Queue에 이미 긴 backoff로 등록된 작업이 존재한다.

```
대응:
- 비활성화 시 기존 Non-ready 작업은 그대로 만료 대기
- 급하면 Non-ready Queue의 모든 score를 now로 갱신하여 즉시 이동
```

### 후속 Step 연동 인터페이스

#### Step 4 (Worker Pool) — Fetcher에서 혼잡 제어 호출

Step 4의 Fetcher가 Fair Queue에서 dequeue한 작업을 admit()으로 넘길 때,
내부적으로 `CongestionControlService.addToNonReady()`가 호출된다.
Worker가 외부 API에서 429 응답을 받으면 `BackpressureService.requeue()`를 통해
혼잡 제어 경로로 재진입한다.

```typescript
// Step 4 Worker에서 429 응답 처리
async processJob(job: Job): Promise<void> {
  try {
    const result = await this.externalApi.call(job);
    await this.completeJob(job, result);
  } catch (error) {
    if (error.status === 429) {
      // ★ Step 3 혼잡 제어 경로로 재진입
      await this.backpressure.requeue(job.id, job.groupId, job.retryCount);
    } else {
      await this.failJob(job, error);
    }
  }
}
```

#### Step 5 (Watcher) — 그룹 완료 시 혼잡 통계 초기화

Step 5의 Watcher가 그룹의 모든 작업 완료를 감지하면
`CongestionControlService.resetGroupStats()`를 호출하여 혼잡 통계를 정리한다.

```typescript
// Step 5 Watcher에서 그룹 완료 감지 시
async onGroupComplete(groupId: string): Promise<void> {
  // 혼잡 통계 초기화 (non-ready-count, stats Hash 삭제)
  await this.congestionControl.resetGroupStats(groupId);
  // active-groups에서 제거 (Step 2 연동)
  await this.redis.srem('active-groups', groupId);
  this.logger.log(`Group ${groupId} completed, congestion stats reset`);
}
```

#### Step 6 (Reliable Queue) — 혼잡 카운트와 Orphan Recovery 정합성

Step 6의 Orphan Recovery가 In-flight Queue에서 미완료 작업을 감지하여
Non-ready Queue로 복구할 때, `CongestionControlService.addToNonReady()`를 사용해야
혼잡 카운트가 정확하게 유지된다.

직접 `ZADD`로 Non-ready Queue에 넣으면 `congestion:{groupId}:non-ready-count`가
갱신되지 않아 backoff 계산이 부정확해진다.

```typescript
// Step 6 Orphan Recovery에서 작업 복구 시
async recoverOrphanJob(jobId: string, groupId: string): Promise<void> {
  // ✅ 올바른 방법: CongestionControlService 경유
  await this.congestionControl.addToNonReady(jobId, groupId);

  // ❌ 잘못된 방법: 직접 ZADD (카운트 불일치 발생)
  // await this.redis.zadd('non-ready-queue', (Date.now() + 1000).toString(), jobId);
}
```

### 다음 단계

Step 3까지 구현되면 **Fair Queue(Step 1) → Rate Limiting(Step 2) → 혼잡 제어(Step 3)**의 흐름 제어 계층이 완성된다. Step 4(Worker Pool)에서는 이 파이프라인을 소비하는 Fetcher / Worker / Dispatcher를 구현하여 실제 작업을 처리한다.

```
Step 1~3: "어떤 순서로, 얼마나 빨리, 언제 재시도할지" 결정
Step 4:   "실제로 작업을 꺼내서 실행하는" 실행 엔진
```


### 문서 갱신 히스토리

#### 1. 2026-02-04
```
#: 1                                                                                                            
이슈: congestion_backoff.lua maxBackoffMs 상한 미적용                                                           
적용 내용: ARGV[5] 추가, clamp 로직 삽입 (이전 세션에서 완료)                                                   
────────────────────────────────────────                                                                        
#: 2                                                                                                            
이슈: Dispatcher groupId별 카운트 감소 구현 미확정                                                              
적용 내용: 방법 3 (Lua 스크립트 내 처리) 을 권장 방안으로 명시, move_to_ready.lua 확장 코드 예시 추가           
────────────────────────────────────────                                                                        
#: 3                                                                                                            
이슈: addToNonReady() BackoffCalculator 이중 계산                                                               
적용 내용: Lua 결과를 직접 사용하도록 변경, BackoffCalculator.classify() public 메서드 추가                     
────────────────────────────────────────                                                                        
#: 4                                                                                                            
이슈: 성능 분석 maxBackoff 제한 미반영                                                                          
적용 내용: 원시값 1,491초 → maxBackoffMs(120초) 클램핑 과정을 명시                                              
────────────────────────────────────────                                                                        
#: 5                                                                                                            
이슈: NonReadyQueueService와 CongestionControlService 역할 중복                                                 
적용 내용: 서비스 교체 가이드 테이블 및 이중 등록 방지 주의사항 추가                                            
────────────────────────────────────────                                                                        
#: 6                                                                                                            
이슈: snapshotCongestion() LTRIM 보관 기준 오류                                                                 
적용 내용: statsRetentionMs / snapshotIntervalMs로 정확한 maxEntries 계산, 주석으로 설명                        
────────────────────────────────────────                                                                        
#: 7                                                                                                            
이슈: 후속 Step 연동 인터페이스 부재                                                                            
적용 내용: Step 4 (Worker 429 재진입), Step 5 (resetGroupStats), Step 6 (Orphan Recovery 경유) 연동 코드 예시   
추가                                                                                                            
────────────────────────────────────────                                                                        
#: 8                                                                                                            
이슈: Lua 스크립트 ioredis keyPrefix 충돌 경고 누락                                                             
적용 내용: keyPrefix 이중 접두사 문제 설명, 3가지 해결 방법, move_to_ready.lua 확장 시 주의 안내 추가
```

#### 2. 2026-02-10 — 구현 코드 기반 전면 최신화
```
#: 9
이슈: congestion-backoff.lua ARGV 순서 및 시각 산출 방식 불일치
적용 내용: ARGV에서 groupId 제거, redis.call('TIME') → Date.now() ARGV 전달로 변경,
stats Hash 필드를 currentNonReadyCount/lastBackoffMs/rateLimitSpeed/lastUpdatedMs로 갱신
────────────────────────────────────────
#: 10
이슈: Lua 파일명 underscore vs kebab-case 불일치
적용 내용: congestion_backoff.lua → congestion-backoff.lua, congestion_release.lua → congestion-release.lua
────────────────────────────────────────
#: 11
이슈: BackoffResult 인터페이스 불일치 (estimatedWaitSec 존재, nonReadyCount/rateLimitSpeed 부재)
적용 내용: estimatedWaitSec 제거, nonReadyCount/rateLimitSpeed 추가로 Lua 결과 직접 전달 구조 반영
────────────────────────────────────────
#: 12
이슈: DI 의존성 (ioredis 직접 주입 vs RedisService + RedisKeyBuilder)
적용 내용: 모든 서비스 코드를 RedisService + RedisKeyBuilder 기반으로 갱신
────────────────────────────────────────
#: 13
이슈: GroupCongestionState/SystemCongestionSummary 인터페이스 불일치
적용 내용: GroupCongestionState에서 totalThrottleCount/lastThrottleAt/avgThrottlePerJob 제거,
currentBackoffMs → lastBackoffMs 변경. SystemCongestionSummary 단순화 (worst* 제거, groups 배열)
────────────────────────────────────────
#: 14
이슈: DispatcherService가 CongestionControlService를 직접 주입하는 설계 → Lua 내부 처리로 변경
적용 내용: move-to-ready.lua의 congestion 카운터 감소 통합 코드 반영,
DispatcherService에서 CongestionControlService 의존 제거, updateCongestionCounters() 메서드 제거
────────────────────────────────────────
#: 15
이슈: BackpressureService에서 NonReadyQueueService 의존 잔존
적용 내용: NonReadyQueueService 의존 제거 반영, reason 문자열에 Rate Limit 상세 정보 포함
────────────────────────────────────────
#: 16
이슈: BulkActionConfig에 workerPool 섹션 누락, 설정 구조 변경 미반영
적용 내용: WorkerPoolConfig 인터페이스 추가, 섹션별 DEFAULT 상수 분리 구조 반영,
BulkActionRedisConfig extends RedisConfig 변경
────────────────────────────────────────
#: 17
이슈: 디렉토리 구조 (파일명 케이싱, 테스트 위치)
적용 내용: PascalCase 파일명, test/ 디렉토리 분리, congestion.constants.ts 제거 반영
────────────────────────────────────────
#: 18
이슈: CongestionStatsService.recordJobCompletion() 평균 계산 방식 불일치
적용 내용: 단순 나눗셈 → 증분 평균(incremental mean) 공식 반영
────────────────────────────────────────
#: 19
이슈: 테스트 코드가 실제 테스트 파일과 불일치
적용 내용: BackoffCalculator.spec.ts, CongestionControlService.spec.ts를 실제 구현 기반으로 전면 갱신.
given/when/then 주석 패턴, RedisService + RedisKeyBuilder 기반 setup 반영
────────────────────────────────────────
#: 20
이슈: estimateCompletionTime 시그니처 불일치
적용 내용: 객체 파라미터 → positional 파라미터, 반환값 {estimatedSeconds, estimatedAt: Date} → number(ms)
```
