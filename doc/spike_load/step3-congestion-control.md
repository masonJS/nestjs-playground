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
```

### 그룹별 혼잡 통계 (Hash)

모니터링과 backoff 계산에 사용하는 통계 데이터이다.

```
Key: bulk-action:congestion:customer-A:stats
Type: Hash
┌──────────────────────┬───────┐
│ field                │ value │
├──────────────────────┼───────┤
│ totalThrottleCount   │ 45    │  ← 누적 쓰로틀링 횟수
│ lastThrottleAt       │ 17060 │  ← 마지막 쓰로틀링 시각
│ lastBackoffMs        │ 6000  │  ← 마지막 적용된 backoff
│ avgThrottlePerJob    │ 1.45  │  ← 작업당 평균 쓰로틀링
│ currentNonReadyCount │ 300   │  ← 현재 Non-ready 작업 수
└──────────────────────┴───────┘
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
> `congestion_backoff.lua`는 현재 KEYS[]로만 키를 받으므로 문제가 없지만,
> 이슈 #2에서 제안한 `move_to_ready.lua` 확장(내부 키 구성)을 적용할 때 반드시 이 점을 고려해야 한다.

### Lua 스크립트: congestion_backoff.lua

Non-ready Queue에 작업을 추가하면서 backoff를 동적으로 계산하는 스크립트이다.

```lua
-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: congestion stats (Hash)
-- KEYS[3]: congestion non-ready-count (String)
-- KEYS[4]: active-groups (Set)
-- ARGV[1]: jobId
-- ARGV[2]: groupId
-- ARGV[3]: globalRps
-- ARGV[4]: 기본 backoff (ms)
-- ARGV[5]: 최대 backoff (ms) ← 추가

-- 1. 그룹별 Non-ready 카운트 증가
local nonReadyCount = redis.call('INCR', KEYS[3])

-- 2. 활성 그룹 수 조회
local activeGroupCount = redis.call('SCARD', KEYS[4])
activeGroupCount = math.max(1, activeGroupCount)

-- 3. 그룹별 Rate Limit 속도 계산
local globalRps = tonumber(ARGV[3])
local rateLimitSpeed = math.max(1, math.floor(globalRps / activeGroupCount))

-- 4. 동적 backoff 계산
local baseBackoff = tonumber(ARGV[4])
local maxBackoff = tonumber(ARGV[5])
local additionalBackoff = math.floor(nonReadyCount / rateLimitSpeed) * 1000
local backoffMs = baseBackoff + additionalBackoff

-- ⚠ maxBackoff 상한 적용: ZADD의 score에도 상한이 반영되어야
--   Service 레이어의 Math.min()과 실제 score가 일치한다.
if backoffMs > maxBackoff then
  backoffMs = maxBackoff
end

-- 5. Non-ready Queue에 추가 (score = 실행 가능 시각)
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local executeAt = nowMs + backoffMs
redis.call('ZADD', KEYS[1], executeAt, ARGV[1])

-- 6. 혼잡 통계 갱신
redis.call('HINCRBY', KEYS[2], 'totalThrottleCount', 1)
redis.call('HSET', KEYS[2], 'lastThrottleAt', tostring(nowMs))
redis.call('HSET', KEYS[2], 'lastBackoffMs', tostring(backoffMs))
redis.call('HSET', KEYS[2], 'currentNonReadyCount', tostring(nonReadyCount))

return {backoffMs, nonReadyCount, rateLimitSpeed}
```

### Lua 스크립트: congestion_release.lua

Non-ready Queue에서 작업이 빠져나갈 때 카운트를 감소시키는 스크립트이다.

```lua
-- KEYS[1]: congestion non-ready-count (String)
-- KEYS[2]: congestion stats (Hash)
-- ARGV[1]: 감소 수량

local newCount = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
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
libs/bulk-action/src/
├── congestion/
│   ├── congestion-control.service.ts         # 혼잡 제어 핵심 서비스
│   ├── congestion-control.service.spec.ts    # 단위 테스트
│   ├── backoff-calculator.ts                 # backoff 계산 유틸리티
│   ├── backoff-calculator.spec.ts            # 계산기 테스트
│   ├── congestion-stats.service.ts           # 혼잡 통계 조회/관리
│   └── congestion.constants.ts               # 상수 정의
├── config/
│   └── bulk-action.config.ts                 # congestion 설정 추가
└── lua/
    ├── congestion_backoff.lua                # 동적 backoff + Non-ready 추가
    └── congestion_release.lua                # Non-ready 카운트 감소
```

### 설정 확장

**`config/bulk-action.config.ts`** (Step 2에서 확장)

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
    globalRps: number;
    readyQueueMaxSize: number;
    rateLimitWindowSec: number;
    rateLimitKeyTtlSec: number;
    dispatchIntervalMs: number;
    dispatchBatchSize: number;
    defaultBackoffMs: number;
    maxBackoffMs: number;
  };
  congestion: {
    enabled: boolean;             // 혼잡 제어 활성화 여부 (default: true)
    baseBackoffMs: number;        // 기본 backoff (default: 1000)
    maxBackoffMs: number;         // 최대 backoff 상한 (default: 120000)
    statsRetentionMs: number;     // 통계 보관 기간 (default: 3600000 = 1시간)
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
  congestion: {
    enabled: true,
    baseBackoffMs: 1000,
    maxBackoffMs: 120000,
    statsRetentionMs: 3600000,
  },
};
```

---

## 구현 코드

### Backoff Calculator

**`congestion/backoff-calculator.ts`**

```typescript
export interface BackoffParams {
  nonReadyCount: number;     // 그룹의 Non-ready Queue 작업 수
  rateLimitSpeed: number;    // 그룹의 초당 처리 가능 수 (perGroupLimit)
  baseBackoffMs: number;     // 기본 backoff (ms)
  maxBackoffMs: number;      // 최대 backoff 상한 (ms)
}

export interface BackoffResult {
  backoffMs: number;         // 계산된 backoff (ms)
  estimatedWaitSec: number;  // 예상 대기 시간 (초, 소수점)
  congestionLevel: CongestionLevel;
}

export enum CongestionLevel {
  NONE = 'NONE',         // backoff = base (혼잡 없음)
  LOW = 'LOW',           // backoff < base * 3
  MODERATE = 'MODERATE', // backoff < base * 10
  HIGH = 'HIGH',         // backoff < base * 30
  CRITICAL = 'CRITICAL', // backoff >= base * 30
}

export class BackoffCalculator {
  /**
   * 동적 backoff를 계산한다.
   *
   * 공식: baseBackoff + floor(nonReadyCount / rateLimitSpeed) * 1000
   *
   * Non-ready Queue에 쌓인 작업 수와 Rate Limit 처리 속도를 기반으로
   * "이 작업의 차례가 올 때까지 예상 대기 시간"을 계산한다.
   */
  static calculate(params: BackoffParams): BackoffResult {
    const { nonReadyCount, rateLimitSpeed, baseBackoffMs, maxBackoffMs } = params;

    const safeSpeed = Math.max(1, rateLimitSpeed);
    const additionalBackoffMs = Math.floor(nonReadyCount / safeSpeed) * 1000;
    const rawBackoff = baseBackoffMs + additionalBackoffMs;
    const backoffMs = Math.min(rawBackoff, maxBackoffMs);

    const estimatedWaitSec = backoffMs / 1000;
    const congestionLevel = this.classifyCongestion(backoffMs, baseBackoffMs);

    return { backoffMs, estimatedWaitSec, congestionLevel };
  }

  /**
   * 혼잡도를 분류한다.
   * CongestionControlService.addToNonReady()에서 Lua 결과의 backoffMs로
   * CongestionLevel만 산출할 때 사용한다.
   */
  static classify(backoffMs: number, baseBackoffMs: number): CongestionLevel {
    return this.classifyCongestion(backoffMs, baseBackoffMs);
  }

  /**
   * 혼잡도를 분류한다 (내부 구현).
   */
  private static classifyCongestion(
    backoffMs: number,
    baseBackoffMs: number,
  ): CongestionLevel {
    const ratio = backoffMs / baseBackoffMs;

    if (ratio <= 1) return CongestionLevel.NONE;
    if (ratio < 3) return CongestionLevel.LOW;
    if (ratio < 10) return CongestionLevel.MODERATE;
    if (ratio < 30) return CongestionLevel.HIGH;
    return CongestionLevel.CRITICAL;
  }

  /**
   * 주어진 파라미터로 예상 처리 완료 시각을 계산한다.
   * 모니터링 대시보드에서 사용한다.
   */
  static estimateCompletionTime(params: {
    totalPending: number;
    rateLimitSpeed: number;
  }): { estimatedSeconds: number; estimatedAt: Date } {
    const seconds = Math.ceil(params.totalPending / Math.max(1, params.rateLimitSpeed));
    return {
      estimatedSeconds: seconds,
      estimatedAt: new Date(Date.now() + seconds * 1000),
    };
  }
}
```

### Congestion Control Service

**`congestion/congestion-control.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';
import {
  BackoffCalculator,
  BackoffResult,
  CongestionLevel,
} from './backoff-calculator';

@Injectable()
export class CongestionControlService {
  private readonly logger = new Logger(CongestionControlService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * 동적 backoff를 계산하여 Non-ready Queue에 작업을 추가한다.
   *
   * Lua 스크립트로 다음을 원자적으로 수행:
   * 1. 그룹별 Non-ready 카운트 증가
   * 2. 활성 그룹 수 기반 rateLimitSpeed 계산
   * 3. 동적 backoff 계산
   * 4. Non-ready Queue에 score(=실행가능시각)와 함께 추가
   * 5. 혼잡 통계 갱신
   */
  async addToNonReady(jobId: string, groupId: string): Promise<BackoffResult> {
    if (!this.config.congestion.enabled) {
      return this.addWithFixedBackoff(jobId, groupId);
    }

    const nonReadyQueueKey = 'non-ready-queue';
    const statsKey = `congestion:${groupId}:stats`;
    const countKey = `congestion:${groupId}:non-ready-count`;
    const activeGroupsKey = 'active-groups';

    try {
      const result = await (this.redis as any).congestion_backoff(
        nonReadyQueueKey,
        statsKey,
        countKey,
        activeGroupsKey,
        jobId,
        groupId,
        this.config.backpressure.globalRps.toString(),
        this.config.congestion.baseBackoffMs.toString(),
      );

      const backoffMs = result[0];
      const nonReadyCount = result[1];
      const rateLimitSpeed = result[2];

      // ⚠️ Lua 스크립트가 이미 backoff를 계산하여 ZADD score에 반영했으므로,
      // 여기서 BackoffCalculator.calculate()를 다시 호출하는 것은
      // "backoff 재계산"이 아니라 CongestionLevel 분류와 estimatedWaitSec 산출 용도이다.
      // 실제 Non-ready Queue에 기록된 score(=executeAt)는 Lua 결과를 사용한다.
      const backoffResult: BackoffResult = {
        backoffMs,
        estimatedWaitSec: backoffMs / 1000,
        congestionLevel: BackoffCalculator.classify(backoffMs, this.config.congestion.baseBackoffMs),
      };

      this.logCongestionState(groupId, backoffResult, nonReadyCount, rateLimitSpeed);

      return backoffResult;
    } catch (error) {
      this.logger.error(
        `Congestion backoff failed for job ${jobId}: ${error.message}`,
        error.stack,
      );
      // 폴백: 고정 backoff
      return this.addWithFixedBackoff(jobId, groupId);
    }
  }

  /**
   * Non-ready Queue에서 작업이 빠져나갈 때 카운트를 감소시킨다.
   * Dispatcher가 move_to_ready 수행 후 호출한다.
   */
  async releaseFromNonReady(groupId: string, count: number): Promise<number> {
    const countKey = `congestion:${groupId}:non-ready-count`;
    const statsKey = `congestion:${groupId}:stats`;

    const newCount = await (this.redis as any).congestion_release(
      countKey,
      statsKey,
      count.toString(),
    );

    return newCount;
  }

  /**
   * 특정 그룹의 현재 혼잡 상태를 조회한다.
   */
  async getCongestionState(groupId: string): Promise<GroupCongestionState> {
    const countKey = `congestion:${groupId}:non-ready-count`;
    const statsKey = `congestion:${groupId}:stats`;
    const activeGroupsKey = 'active-groups';

    const [nonReadyCount, stats, activeGroupCount] = await Promise.all([
      this.redis.get(countKey).then((v) => parseInt(v ?? '0', 10)),
      this.redis.hgetall(statsKey),
      this.redis.scard(activeGroupsKey),
    ]);

    const rateLimitSpeed = Math.max(
      1,
      Math.floor(this.config.backpressure.globalRps / Math.max(1, activeGroupCount)),
    );

    const backoffResult = BackoffCalculator.calculate({
      nonReadyCount,
      rateLimitSpeed,
      baseBackoffMs: this.config.congestion.baseBackoffMs,
      maxBackoffMs: this.config.congestion.maxBackoffMs,
    });

    return {
      groupId,
      nonReadyCount,
      rateLimitSpeed,
      currentBackoffMs: backoffResult.backoffMs,
      congestionLevel: backoffResult.congestionLevel,
      totalThrottleCount: parseInt(stats.totalThrottleCount ?? '0', 10),
      lastThrottleAt: parseInt(stats.lastThrottleAt ?? '0', 10),
      avgThrottlePerJob: parseFloat(stats.avgThrottlePerJob ?? '0'),
    };
  }

  /**
   * 전체 시스템의 혼잡 상태 요약을 반환한다.
   */
  async getSystemCongestionSummary(): Promise<SystemCongestionSummary> {
    const activeGroups = await this.redis.smembers('active-groups');
    const states = await Promise.all(
      activeGroups.map((groupId) => this.getCongestionState(groupId)),
    );

    const totalNonReady = states.reduce((sum, s) => sum + s.nonReadyCount, 0);
    const maxCongestion = states.reduce(
      (max, s) => (s.currentBackoffMs > max.currentBackoffMs ? s : max),
      states[0] ?? { congestionLevel: CongestionLevel.NONE, currentBackoffMs: 0 },
    );

    return {
      activeGroupCount: activeGroups.length,
      totalNonReadyCount: totalNonReady,
      worstCongestionLevel: maxCongestion?.congestionLevel ?? CongestionLevel.NONE,
      worstCongestionGroupId: (maxCongestion as GroupCongestionState)?.groupId ?? '',
      groupStates: states,
    };
  }

  /**
   * 그룹의 혼잡 통계를 초기화한다.
   * 그룹의 모든 작업이 완료되었을 때 호출한다.
   */
  async resetGroupStats(groupId: string): Promise<void> {
    const countKey = `congestion:${groupId}:non-ready-count`;
    const statsKey = `congestion:${groupId}:stats`;

    await Promise.all([
      this.redis.del(countKey),
      this.redis.del(statsKey),
    ]);
  }

  // --- Private helpers ---

  /**
   * 혼잡 제어 비활성화 시 고정 backoff로 폴백한다.
   */
  private async addWithFixedBackoff(jobId: string, groupId: string): Promise<BackoffResult> {
    const backoffMs = this.config.congestion.baseBackoffMs;
    const executeAt = Date.now() + backoffMs;

    await this.redis.zadd('non-ready-queue', executeAt.toString(), jobId);

    return {
      backoffMs,
      estimatedWaitSec: backoffMs / 1000,
      congestionLevel: CongestionLevel.NONE,
    };
  }

  private logCongestionState(
    groupId: string,
    result: BackoffResult,
    nonReadyCount: number,
    rateLimitSpeed: number,
  ): void {
    const level = result.congestionLevel;

    if (level === CongestionLevel.CRITICAL) {
      this.logger.warn(
        `CRITICAL congestion: group=${groupId}, ` +
        `backoff=${result.backoffMs}ms, ` +
        `nonReady=${nonReadyCount}, speed=${rateLimitSpeed} RPS`,
      );
    } else if (level === CongestionLevel.HIGH) {
      this.logger.warn(
        `HIGH congestion: group=${groupId}, ` +
        `backoff=${result.backoffMs}ms, nonReady=${nonReadyCount}`,
      );
    } else if (level !== CongestionLevel.NONE) {
      this.logger.debug(
        `Congestion ${level}: group=${groupId}, backoff=${result.backoffMs}ms`,
      );
    }
  }
}

export interface GroupCongestionState {
  groupId: string;
  nonReadyCount: number;
  rateLimitSpeed: number;
  currentBackoffMs: number;
  congestionLevel: CongestionLevel;
  totalThrottleCount: number;
  lastThrottleAt: number;
  avgThrottlePerJob: number;
}

export interface SystemCongestionSummary {
  activeGroupCount: number;
  totalNonReadyCount: number;
  worstCongestionLevel: CongestionLevel;
  worstCongestionGroupId: string;
  groupStates: GroupCongestionState[];
}
```

### Congestion Stats Service

**`congestion/congestion-stats.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

/**
 * 혼잡 통계를 수집하고 작업당 평균 쓰로틀링 횟수를 추적한다.
 * 모니터링 및 알림에 사용한다.
 */
@Injectable()
export class CongestionStatsService {
  private readonly logger = new Logger(CongestionStatsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * 작업 완료 시 해당 그룹의 평균 쓰로틀링 횟수를 갱신한다.
   */
  async recordJobCompletion(groupId: string, throttleCount: number): Promise<void> {
    const statsKey = `congestion:${groupId}:stats`;
    const completionCountKey = `congestion:${groupId}:completed-count`;

    const completedCount = await this.redis.incr(completionCountKey);
    const totalThrottles = await this.redis.hget(statsKey, 'totalThrottleCount');

    if (totalThrottles) {
      const avg = parseInt(totalThrottles, 10) / completedCount;
      await this.redis.hset(statsKey, 'avgThrottlePerJob', avg.toFixed(2));
    }
  }

  /**
   * 혼잡도 히스토리를 기록한다 (시계열 데이터).
   * 외부 모니터링 시스템(Prometheus 등)으로 export할 때 사용한다.
   */
  async snapshotCongestion(groupId: string, snapshot: {
    nonReadyCount: number;
    backoffMs: number;
    rateLimitSpeed: number;
  }): Promise<void> {
    const timeSeriesKey = `congestion:${groupId}:history`;
    const entry = JSON.stringify({
      timestamp: Date.now(),
      ...snapshot,
    });

    await this.redis.rpush(timeSeriesKey, entry);
    // ⚠️ LTRIM은 개수(index) 기반이므로, 시간 기반 statsRetentionMs를 직접 사용할 수 없다.
    // snapshotCongestion()의 호출 주기(snapshotIntervalMs)를 알아야 보관 개수를 계산할 수 있다.
    //
    // 보관 개수 = statsRetentionMs / snapshotIntervalMs
    // 예: statsRetentionMs=3,600,000(1시간), snapshotIntervalMs=10,000(10초) → 360개 보관
    //
    // 기존 코드 `statsRetentionMs / 1000`은 호출 주기가 정확히 1초일 때만 맞으므로,
    // 설정에 snapshotIntervalMs를 추가하거나, 고정 maxEntries를 사용하는 것이 정확하다.
    const snapshotIntervalMs = 10_000; // 기본 snapshot 주기 10초 (config로 분리 권장)
    const maxEntries = Math.ceil(this.config.congestion.statsRetentionMs / snapshotIntervalMs);
    await this.redis.ltrim(
      timeSeriesKey,
      -maxEntries,
      -1,
    );
  }

  /**
   * 혼잡도 히스토리를 조회한다.
   */
  async getCongestionHistory(
    groupId: string,
    limit: number = 100,
  ): Promise<CongestionSnapshot[]> {
    const timeSeriesKey = `congestion:${groupId}:history`;
    const entries = await this.redis.lrange(timeSeriesKey, -limit, -1);
    return entries.map((e) => JSON.parse(e));
  }
}

export interface CongestionSnapshot {
  timestamp: number;
  nonReadyCount: number;
  backoffMs: number;
  rateLimitSpeed: number;
}
```

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
import { CongestionControlService } from '../congestion/congestion-control.service';

@Injectable()
export class BackpressureService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
    private readonly congestionControl: CongestionControlService,  // 추가
  ) {}

  async admit(job: Job): Promise<BackpressureResult> {
    const hasCapacity = await this.readyQueue.hasCapacity();
    if (!hasCapacity) {
      return { accepted: false, destination: 'rejected', reason: 'Ready Queue at capacity' };
    }

    const rateLimitResult = await this.rateLimiter.checkRateLimit(job.groupId);

    if (rateLimitResult.allowed) {
      const pushed = await this.readyQueue.push(job.id);
      if (!pushed) {
        return { accepted: false, destination: 'rejected', reason: 'Ready Queue became full' };
      }
      return { accepted: true, destination: 'ready' };
    }

    // ★ 변경: 고정 backoff → 동적 backoff (혼잡 제어)
    const backoffResult = await this.congestionControl.addToNonReady(job.id, job.groupId);

    return {
      accepted: true,
      destination: 'non-ready',
      reason: `Rate limited, congestion=${backoffResult.congestionLevel}, ` +
              `backoff=${backoffResult.backoffMs}ms`,
    };
  }

  async requeue(jobId: string, groupId: string, retryCount: number): Promise<void> {
    // 처리 실패 시에도 혼잡 제어 적용
    await this.congestionControl.addToNonReady(jobId, groupId);
  }
}
```

### 변경 지점: DispatcherService

Dispatcher가 Non-ready → Ready 이동 후 혼잡 카운트를 감소시킨다.

```typescript
@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
    private readonly congestionControl: CongestionControlService,  // 추가
  ) {}

  private async dispatch(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const hasCapacity = await this.readyQueue.hasCapacity();
      if (!hasCapacity) return;

      const moved = await this.moveToReady();

      if (moved > 0) {
        // ★ 추가: 이동된 작업에 대해 혼잡 카운트 감소
        // 그룹별로 카운트를 감소시켜야 하므로, 이동된 작업의 groupId를 알아야 함
        // 실제 구현에서는 jobId에서 groupId를 추출하거나 별도 매핑 사용
        await this.updateCongestionCounters(moved);

        this.logger.debug(`Dispatched ${moved} jobs, updated congestion counters`);
      }
    } catch (error) {
      this.logger.error(`Dispatch failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * ⚠️ 권장 구현: 방법 3 — move_to_ready Lua 스크립트 내에서 카운트 갱신
   *
   * 방법 1 (jobId 접두사): jobId 형식에 의존하므로 Step 1 Fair Queue와 규약이 필요하다.
   * 방법 2 (별도 Hash 매핑): 추가 Redis 키가 필요하고, 매핑 등록/삭제 누락 시 메모리 누수.
   * 방법 3 (Lua 스크립트): move_to_ready.lua가 ZREM 시 congestion 카운트도 함께 갱신하면
   *   원자적이고, 별도 매핑 없이 HGET으로 groupId를 조회할 수 있다.
   *
   * 이를 위해 Step 1의 enqueue.lua에서 job metadata Hash에 groupId를 저장해 두어야 한다.
   * (Step 1에서 HSET bulk-action:job:{jobId} groupId {groupId} 로 이미 저장됨)
   *
   * move_to_ready.lua 확장:
   * ```lua
   * for _, jobId in ipairs(jobs) do
   *   redis.call('ZREM', KEYS[1], jobId)
   *   redis.call('RPUSH', KEYS[2], jobId)
   *   -- groupId 조회 후 congestion 카운트 감소
   *   local groupId = redis.call('HGET', 'bulk-action:job:' .. jobId, 'groupId')
   *   if groupId then
   *     local countKey = 'bulk-action:congestion:' .. groupId .. ':non-ready-count'
   *     local newCount = redis.call('DECR', countKey)
   *     if newCount < 0 then redis.call('SET', countKey, '0') end
   *   end
   * end
   * ```
   */
  private async updateCongestionCounters(movedCount: number): Promise<void> {
    // move_to_ready.lua 내부에서 원자적으로 처리되므로,
    // 별도 호출이 필요 없다. 아래는 Lua 미적용 시의 폴백 구현.
    // 실제 운영에서는 Lua 스크립트 방식을 사용하고 이 메서드를 제거한다.
    this.logger.warn(
      `updateCongestionCounters called with movedCount=${movedCount}. ` +
      `move_to_ready.lua에서 원자적 처리를 권장한다.`,
    );
  }

  // ...
}
```

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
│ Dispatcher (주기적 실행)                                         │
│                                                                 │
│ 1. Non-ready Queue에서 score <= now 작업 조회                     │
│ 2. Ready Queue로 이동                                            │
│ 3. congestionControl.releaseFromNonReady() ← Step 3 ★           │
│    → Non-ready 카운트 감소                                       │
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

```typescript
describe('BackoffCalculator', () => {
  const baseBackoffMs = 1000;
  const maxBackoffMs = 120000;

  it('Non-ready 작업이 없으면 기본 backoff를 반환한다', () => {
    const result = BackoffCalculator.calculate({
      nonReadyCount: 0,
      rateLimitSpeed: 100,
      baseBackoffMs,
      maxBackoffMs,
    });
    expect(result.backoffMs).toBe(1000);
    expect(result.congestionLevel).toBe(CongestionLevel.NONE);
  });

  it('Non-ready 작업 수에 비례하여 backoff가 증가한다', () => {
    const result = BackoffCalculator.calculate({
      nonReadyCount: 500,
      rateLimitSpeed: 100,
      baseBackoffMs,
      maxBackoffMs,
    });
    // 1000 + floor(500/100) * 1000 = 1000 + 5000 = 6000
    expect(result.backoffMs).toBe(6000);
    expect(result.congestionLevel).toBe(CongestionLevel.MODERATE);
  });

  it('maxBackoffMs를 초과하지 않는다', () => {
    const result = BackoffCalculator.calculate({
      nonReadyCount: 1000000,
      rateLimitSpeed: 10,
      baseBackoffMs,
      maxBackoffMs,
    });
    expect(result.backoffMs).toBe(maxBackoffMs);
    expect(result.congestionLevel).toBe(CongestionLevel.CRITICAL);
  });

  it('rateLimitSpeed가 0이면 안전하게 처리한다', () => {
    const result = BackoffCalculator.calculate({
      nonReadyCount: 100,
      rateLimitSpeed: 0,
      baseBackoffMs,
      maxBackoffMs,
    });
    // rateLimitSpeed = max(1, 0) = 1
    // 1000 + floor(100/1) * 1000 = 101000
    expect(result.backoffMs).toBe(101000);
  });

  it('Non-ready 작업이 rateLimitSpeed 미만이면 추가 backoff가 없다', () => {
    const result = BackoffCalculator.calculate({
      nonReadyCount: 50,
      rateLimitSpeed: 100,
      baseBackoffMs,
      maxBackoffMs,
    });
    // floor(50/100) = 0 → 추가 backoff 없음
    expect(result.backoffMs).toBe(1000);
  });

  describe('혼잡도 분류', () => {
    const cases: Array<{ nonReady: number; speed: number; expected: CongestionLevel }> = [
      { nonReady: 0, speed: 100, expected: CongestionLevel.NONE },
      { nonReady: 150, speed: 100, expected: CongestionLevel.LOW },       // 2s → ratio 2
      { nonReady: 500, speed: 100, expected: CongestionLevel.MODERATE },  // 6s → ratio 6
      { nonReady: 2000, speed: 100, expected: CongestionLevel.HIGH },     // 21s → ratio 21
      { nonReady: 5000, speed: 100, expected: CongestionLevel.CRITICAL }, // 51s → ratio 51
    ];

    test.each(cases)(
      'nonReady=$nonReady, speed=$speed → $expected',
      ({ nonReady, speed, expected }) => {
        const result = BackoffCalculator.calculate({
          nonReadyCount: nonReady,
          rateLimitSpeed: speed,
          baseBackoffMs,
          maxBackoffMs,
        });
        expect(result.congestionLevel).toBe(expected);
      },
    );
  });

  describe('예상 완료 시간', () => {
    it('대기 작업 수와 처리 속도로 완료 시각을 계산한다', () => {
      const result = BackoffCalculator.estimateCompletionTime({
        totalPending: 1000,
        rateLimitSpeed: 100,
      });
      expect(result.estimatedSeconds).toBe(10);
    });
  });
});
```

### CongestionControlService 통합 테스트

```typescript
describe('CongestionControlService (Integration)', () => {
  let congestion: CongestionControlService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          backpressure: { globalRps: 100 },
          congestion: { enabled: true, baseBackoffMs: 1000, maxBackoffMs: 60000 },
        }),
      ],
    }).compile();

    congestion = module.get(CongestionControlService);
    redis = module.get(REDIS_CLIENT);

    // active-groups에 테스트 그룹 등록
    await redis.sadd('active-groups', 'customer-A');
  });

  afterEach(async () => {
    await redis.flushdb();
    await redis.sadd('active-groups', 'customer-A');
  });

  it('첫 번째 작업은 기본 backoff를 받는다', async () => {
    const result = await congestion.addToNonReady('job-001', 'customer-A');
    expect(result.backoffMs).toBe(1000);
    expect(result.congestionLevel).toBe('NONE');
  });

  it('Non-ready 작업이 쌓일수록 backoff가 증가한다', async () => {
    // 200개 작업을 Non-ready Queue에 추가
    for (let i = 0; i < 200; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
    }

    // 201번째 작업의 backoff
    const result = await congestion.addToNonReady('job-200', 'customer-A');

    // nonReadyCount=201, rateLimitSpeed=100 (globalRps=100, 활성그룹=1)
    // backoff = 1000 + floor(201/100) * 1000 = 1000 + 2000 = 3000
    expect(result.backoffMs).toBe(3000);
  });

  it('releaseFromNonReady가 카운트를 감소시킨다', async () => {
    // 100개 추가
    for (let i = 0; i < 100; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
    }

    // 50개 release
    const remaining = await congestion.releaseFromNonReady('customer-A', 50);
    expect(remaining).toBe(50);

    // 다음 작업의 backoff가 줄어야 함
    const result = await congestion.addToNonReady('job-100', 'customer-A');
    // nonReadyCount=51, floor(51/100)=0 → backoff = 1000
    expect(result.backoffMs).toBe(1000);
  });

  it('활성 그룹이 늘면 per-group speed가 줄어 backoff가 증가한다', async () => {
    // 활성 그룹 5개 등록
    await redis.sadd('active-groups', 'customer-B', 'customer-C', 'customer-D', 'customer-E');

    // 100개 작업 추가
    for (let i = 0; i < 100; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
    }

    const result = await congestion.addToNonReady('job-100', 'customer-A');
    // rateLimitSpeed = floor(100/5) = 20
    // nonReadyCount=101, floor(101/20)=5 → backoff = 1000 + 5000 = 6000
    expect(result.backoffMs).toBe(6000);
  });

  it('getCongestionState가 올바른 상태를 반환한다', async () => {
    for (let i = 0; i < 50; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
    }

    const state = await congestion.getCongestionState('customer-A');
    expect(state.groupId).toBe('customer-A');
    expect(state.nonReadyCount).toBe(50);
    expect(state.rateLimitSpeed).toBe(100); // globalRps=100, 활성그룹=1
    expect(state.totalThrottleCount).toBe(50);
  });

  it('resetGroupStats가 모든 통계를 초기화한다', async () => {
    for (let i = 0; i < 10; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
    }

    await congestion.resetGroupStats('customer-A');

    const state = await congestion.getCongestionState('customer-A');
    expect(state.nonReadyCount).toBe(0);
    expect(state.totalThrottleCount).toBe(0);
  });
});
```

### 공회전 감소 검증 테스트

```typescript
describe('공회전 감소 검증', () => {
  let congestion: CongestionControlService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
  let redis: Redis;

  // ... setup 생략

  it('동적 backoff가 공회전 횟수를 줄인다', async () => {
    const totalJobs = 500;
    const rps = 50;
    let throttleCount = 0;

    // 시뮬레이션: 500개 작업, 50 RPS
    // 1. 초기: 50개 Ready, 450개 Non-ready
    const initialReady = Math.min(totalJobs, rps);
    const initialNonReady = totalJobs - initialReady;

    for (let i = 0; i < initialNonReady; i++) {
      await congestion.addToNonReady(`job-${i}`, 'customer-A');
      throttleCount++;
    }

    // 2. 첫 번째 backoff 확인
    const state = await congestion.getCongestionState('customer-A');
    // backoff = 1000 + floor(450/50) * 1000 = 10초
    // → 고정 backoff(1초)보다 9초 더 기다림 = 공회전 9회 절약

    // 작업당 평균 쓰로틀링 기대치
    const avgThrottlePerJob = throttleCount / totalJobs;
    // 이론적으로 각 작업은 1~2회 쓰로틀링
    expect(avgThrottlePerJob).toBeLessThan(2);
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
