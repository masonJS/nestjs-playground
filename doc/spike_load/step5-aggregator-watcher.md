# Step 5. Aggregator & Watcher 구현

> MapReduce 기반 결과 집계 + 상태 전이 감시

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [상태 전이 머신 (State Machine)](#상태-전이-머신-state-machine)
3. [MapReduce 패턴 적용](#mapreduce-패턴-적용)
4. [분산락 (Distributed Lock)](#분산락-distributed-lock)
5. [Redis 데이터 구조 설계](#redis-데이터-구조-설계)
6. [NestJS 모듈 구조](#nestjs-모듈-구조)
7. [구현 코드](#구현-코드)
8. [Step 1~4와의 연동](#step-14와의-연동)
9. [테스트 전략](#테스트-전략)
10. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### 왜 Aggregator가 필요한가?

벌크액션은 수천~수만 개의 개별 작업(Job)으로 분해되어 병렬 실행된다. 클라이언트에게 의미 있는 결과를 돌려주려면 **개별 결과를 모아 하나의 최종 결과로 집계**해야 한다.

```
클라이언트 요청: "고객 10만 명에게 프로모션 발송"
   │
   ▼
분해: Job 1 ~ Job 100,000
   │
   ▼
병렬 실행 (Worker Pool)
   │
   ▼
개별 결과: { job-1: 성공 }, { job-2: 실패 }, ... { job-100000: 성공 }
   │
   ▼
집계 (Aggregator): {
  total: 100,000,
  success: 98,500,
  failed: 1,500,
  failedTargets: ["user-123", "user-456", ...],
  duration: "12분 34초"
}
   │
   ▼
클라이언트에게 최종 결과 전달
```

### 왜 Watcher가 필요한가?

벌크액션 그룹은 여러 상태를 거쳐 진행된다. 다중 인스턴스 환경에서 **정확히 한 인스턴스만 상태를 전이**시켜야 하며, 전이 조건을 **주기적으로 감시**해야 한다.

| 문제           | Watcher 없이                                                  | Watcher로 해결                       |
| -------------- | ------------------------------------------------------------- | ------------------------------------ |
| 상태 전이 누락 | Worker가 마지막 작업 ACK 시에만 전이 시도 → 실패 시 영구 대기 | 주기적 감시로 누락 발견              |
| 중복 전이      | 다중 인스턴스에서 동시에 전이 시도 → 중복 집계                | 분산락으로 단일 인스턴스만 전이      |
| 타임아웃 감지  | 일부 Job이 실패해도 그룹이 영원히 RUNNING                     | Watcher가 타임아웃 감지 후 강제 전이 |

### MapReduce와의 관계

벌크액션의 결과 집계는 MapReduce 패턴과 정확히 일치한다.

```
           MapReduce                    벌크액션 Aggregator
           ─────────                    ─────────────────
Input:     원본 데이터                    개별 Job 결과
Map:       데이터 → (key, value) 변환    Job → 중간 결과 변환
Shuffle:   같은 key끼리 그룹핑            그룹별로 결과 수집
Reduce:    그룹별 결과 집약               중간 결과 → 최종 결과
Output:    최종 결과                      클라이언트에게 전달할 집계 결과
```

---

## 상태 전이 머신 (State Machine)

### 그룹 상태 정의

```typescript
enum GroupStatus {
  CREATED = 'CREATED', // 그룹 생성됨, Job 등록 중
  DISPATCHED = 'DISPATCHED', // 모든 Job이 Fair Queue에 등록 완료
  RUNNING = 'RUNNING', // Job 실행 중
  AGGREGATING = 'AGGREGATING', // 모든 Job 완료, 결과 집계 중
  COMPLETED = 'COMPLETED', // 집계 완료, 최종 결과 확정
  FAILED = 'FAILED', // 복구 불가 오류 발생
}
```

### 상태 전이 다이어그램

```
                    ┌──────────┐
                    │ CREATED  │
                    └────┬─────┘
                         │ 모든 Job이 Fair Queue에 등록됨
                         ▼
                    ┌──────────┐
                    │DISPATCHED│
                    └────┬─────┘
                         │ 첫 번째 Job 실행 시작
                         ▼
                    ┌──────────┐
               ┌────│ RUNNING  │────┐
               │    └────┬─────┘    │
               │         │          │ 타임아웃 또는
               │         │          │ 복구 불가 오류
               │         │          ▼
               │         │    ┌──────────┐
               │         │    │  FAILED  │
               │         │    └──────────┘
               │         │ 모든 Job 완료 (성공+실패)
               │         ▼
               │    ┌───────────┐
               │    │AGGREGATING│
               │    └─────┬─────┘
               │          │ 집계 완료
               │          ▼
               │    ┌──────────┐
               └───▶│COMPLETED │  (타임아웃으로 강제 완료 시에도)
                    └──────────┘
```

### 전이 조건 상세

| 전이                    | 조건                                      | 트리거                                  |
| ----------------------- | ----------------------------------------- | --------------------------------------- |
| CREATED → DISPATCHED    | `registeredJobs == totalJobs`             | 마지막 Job enqueue 시 또는 Watcher 감시 |
| DISPATCHED → RUNNING    | 첫 번째 Job이 Worker에 의해 처리 시작     | Worker의 첫 process() 호출              |
| RUNNING → AGGREGATING   | `completedJobs + failedJobs == totalJobs` | 마지막 Job ACK 시 또는 Watcher 감시     |
| AGGREGATING → COMPLETED | Aggregator.reduce() 완료                  | Aggregator 실행 후                      |
| \* → FAILED             | 복구 불가 오류 또는 전체 타임아웃 초과    | Watcher 감시                            |

### 전이의 원자성

상태 전이는 반드시 **분산락을 획득한 단일 인스턴스**만 수행한다. 이는 다음을 보장한다:

```
인스턴스 A: Job-999 ACK → "totalJobs==completedJobs? → 전이!"
인스턴스 B: Job-1000 ACK → "totalJobs==completedJobs? → 전이!"

분산락 없이:
  A와 B가 동시에 RUNNING → AGGREGATING 전이 → 중복 집계 발생

분산락 적용:
  A가 락 획득 → 전이 수행 → 락 해제
  B가 락 획득 → 이미 AGGREGATING → 전이 스킵
```

---

## MapReduce 패턴 적용

### Aggregator 인터페이스

```
개별 Job 결과           Map 단계              Reduce 단계           최종 결과
─────────────     ──────────────      ──────────────      ──────────────
Job-1: 성공       → { s:1, f:0 }  ─┐
Job-2: 실패       → { s:0, f:1 }   │   reduce()          { total: 5,
Job-3: 성공       → { s:1, f:0 }   ├─────────────────▶     success: 3,
Job-4: 성공       → { s:1, f:0 }   │                       failed: 2 }
Job-5: 실패       → { s:0, f:1 }  ─┘
```

### 구현 패턴: Incremental vs Batch

| 패턴            | 설명                                               | 장점                         | 단점                               |
| --------------- | -------------------------------------------------- | ---------------------------- | ---------------------------------- |
| **Incremental** | Job 완료마다 중간 결과를 Redis에 누적              | 메모리 효율적, 실시간 진행률 | Redis 연산 많음                    |
| **Batch**       | 모든 Job 완료 후 한 번에 집계                      | 구현 단순                    | 대량 데이터 로드 필요, 메모리 부담 |
| **Hybrid**      | Incremental로 카운터 누적 + Batch로 상세 결과 집계 | 균형잡힌 접근                | 구현 복잡                          |

벌크액션에서는 **Hybrid 패턴**을 채택한다:

- 성공/실패 카운터는 Job ACK 시마다 **Incremental**로 Redis HINCRBY
- 실패 상세 목록은 Redis List에 **Incremental**로 RPUSH
- 최종 집계는 AGGREGATING 단계에서 **Batch**로 수행

```
Job ACK 시 (Incremental):
  HINCRBY group:meta successCount 1
  HINCRBY group:meta failedCount 1
  RPUSH group:failed-details '{"jobId":"j-2","error":"timeout"}'

AGGREGATING 단계 (Batch):
  successCount = HGET group:meta successCount
  failedCount = HGET group:meta failedCount
  failedDetails = LRANGE group:failed-details 0 -1
  finalResult = reduce(successCount, failedCount, failedDetails)
```

---

## 분산락 (Distributed Lock)

### Redlock 알고리즘 개요

다중 인스턴스 환경에서 **정확히 하나의 인스턴스만 상태 전이를 수행**하기 위해 Redis 기반 분산락을 사용한다.

```
인스턴스 A          Redis           인스턴스 B
    │                │                 │
    │  SET lock NX   │                 │
    │───────────────▶│                 │
    │  OK (획득)     │                 │
    │◀───────────────│                 │
    │                │  SET lock NX    │
    │                │◀────────────────│
    │                │  FAIL (거부)    │
    │                │────────────────▶│
    │                │                 │
    │  상태 전이 수행 │                 │  대기 또는 스킵
    │                │                 │
    │  DEL lock      │                 │
    │───────────────▶│                 │
    │                │                 │
```

### 락 설계

| 항목    | 값                                            |
| ------- | --------------------------------------------- |
| 키 패턴 | `bulk-action:lock:group:{groupId}:transition` |
| TTL     | 10초 (전이 작업 최대 소요시간 × 2)            |
| 재시도  | 3회, 100ms 간격                               |
| 값      | 인스턴스 UUID (안전한 해제를 위해)            |

```lua
-- 락 획득 (NX + EX로 원자적)
SET bulk-action:lock:group:customer-A:transition <uuid> NX EX 10

-- 락 해제 (소유자 확인 후 삭제)
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
```

### Watcher에서의 락 활용

```
Watcher 1회 사이클:

  1. 활성 그룹 목록 조회
  2. 각 그룹에 대해:
     a. 현재 상태 확인
     b. 전이 조건 충족 여부 판단
     c. 조건 충족 시:
        - 분산락 획득 시도
        - 획득 성공 → 상태 전이 수행
        - 획득 실패 → 스킵 (다른 인스턴스가 처리 중)
     d. 타임아웃 감지 시:
        - 분산락 획득 후 FAILED 전이
```

---

## Redis 데이터 구조 설계

### 추가 Key 구조

```
# 그룹 상태 및 진행률 (기존 group meta 확장)
bulk-action:group:{groupId}:meta                    # Hash - 상태, 카운터
bulk-action:group:{groupId}:result                  # Hash - 최종 집계 결과

# 개별 Job 결과 수집
bulk-action:group:{groupId}:job-results             # List - 성공 Job 결과 (JSON)
bulk-action:group:{groupId}:failed-details          # List - 실패 상세 (JSON)

# 분산락
bulk-action:lock:group:{groupId}:transition         # String - 전이 락
bulk-action:lock:group:{groupId}:aggregation        # String - 집계 락

# Watcher 관리
bulk-action:watcher:active-groups                   # Set - 감시 대상 그룹 목록
bulk-action:watcher:last-check:{groupId}            # String - 마지막 감시 시각
```

### RedisKeyBuilder 확장

`key/RedisKeyBuilder.ts`에 Step 5용 메서드를 추가한다. 기존 `activeGroups()`는 Rate Limiter 전용이므로 Watcher용은 별도 키를 사용한다.

```typescript
// ── Aggregator ──

groupResult(groupId: string): string {
  return `${this.prefix}group:${groupId}:result`;
}

groupJobResults(groupId: string): string {
  return `${this.prefix}group:${groupId}:job-results`;
}

groupFailedDetails(groupId: string): string {
  return `${this.prefix}group:${groupId}:failed-details`;
}

// ── Lock ──

groupTransitionLock(groupId: string): string {
  return `${this.prefix}lock:group:${groupId}:transition`;
}

groupAggregationLock(groupId: string): string {
  return `${this.prefix}lock:group:${groupId}:aggregation`;
}

// ── Watcher ──

watcherActiveGroups(): string {
  return `${this.prefix}watcher:active-groups`;
}
```

### 그룹 메타데이터 확장 (Hash)

Step 1에서 정의한 `group:meta`에 집계용 필드를 추가한다.

```
Key: bulk-action:group:customer-A:meta
Type: Hash
┌────────────────────┬─────────────┐
│ field              │ value       │
├────────────────────┼─────────────┤
│ basePriority       │ 0           │  ← Step 1
│ totalJobs          │ 10000       │  ← Step 1
│ doneJobs           │ 9800        │  ← Step 1
│ priorityLevel      │ normal      │  ← Step 1
│ createdAt          │ 17060...    │  ← Step 1
│ status             │ RUNNING     │  ← Step 5 확장
│ registeredJobs     │ 10000       │  ← Step 5: 등록 완료된 Job 수
│ successCount       │ 9500        │  ← Step 5: 성공 Job 수
│ failedCount        │ 300         │  ← Step 5: 실패 Job 수
│ firstJobStartedAt  │ 17060...    │  ← Step 5: 첫 Job 실행 시각
│ lastJobCompletedAt │ 17061...    │  ← Step 5: 마지막 Job 완료 시각
│ aggregationStartAt │ 0           │  ← Step 5: 집계 시작 시각
│ completedAt        │ 0           │  ← Step 5: 완료 시각
│ timeoutAt          │ 17065...    │  ← Step 5: 타임아웃 시각
└────────────────────┴─────────────┘
```

### 최종 집계 결과 (Hash)

```
Key: bulk-action:group:customer-A:result
Type: Hash
┌──────────────────┬───────────────────────────────────┐
│ field            │ value                             │
├──────────────────┼───────────────────────────────────┤
│ total            │ 10000                             │
│ success          │ 9500                              │
│ failed           │ 300                               │
│ skipped          │ 200                               │
│ durationMs       │ 125000                            │
│ startedAt        │ 1706000100000                     │
│ completedAt      │ 1706000225000                     │
│ summary          │ {"rate":"95%","avgMs":"12.5"}     │
│ customData       │ (Aggregator.reduce() 결과 JSON)    │
└──────────────────┴───────────────────────────────────┘
```

### Lua 스크립트: record_job_result.lua

Job 완료 시 카운터를 원자적으로 갱신하고 전이 조건을 확인한다.

> **Step 1 `ack.lua`와의 역할 분담:**
>
> - `ack.lua`(Step 1)가 `doneJobs` HINCRBY를 **전담**한다. 작업 상태를 COMPLETED로 변경하고 그룹 완료를 판정하는 것은 `ack.lua`의 책임이다.
> - `record_job_result.lua`(Step 5)는 `successCount`/`failedCount`만 관리하고, `doneJobs`를 건드리지 않는다.
> - 호출 순서: `recordJobResult()` → `ack()` 순으로 호출하여, 카운터 갱신 후 완료 판정이 이루어진다.
> - 논리적으로 `doneJobs == successCount + failedCount`이며, Watcher에서 주기적으로 불일치를 검증할 수 있다.

```lua
-- KEYS[1]: ${prefix}group:{groupId}:meta          (RedisKeyBuilder.groupMeta)
-- KEYS[2]: ${prefix}group:{groupId}:job-results   (성공) 또는
--          ${prefix}group:{groupId}:failed-details (실패) (RedisKeyBuilder.groupJobResults / groupFailedDetails)
-- ARGV[1]: "success" | "failed"
-- ARGV[2]: result JSON
-- ARGV[3]: 현재 시각 (epoch ms)

-- 1. 카운터 갱신 (successCount 또는 failedCount만 관리, doneJobs는 ack.lua 전담)
local field = ARGV[1] == 'success' and 'successCount' or 'failedCount'
redis.call('HINCRBY', KEYS[1], field, 1)
redis.call('HSET', KEYS[1], 'lastJobCompletedAt', ARGV[3])

-- 2. 결과 저장
redis.call('RPUSH', KEYS[2], ARGV[2])

-- 3. 전이 조건 확인
local totalJobs = tonumber(redis.call('HGET', KEYS[1], 'totalJobs') or '0')
local successCount = tonumber(redis.call('HGET', KEYS[1], 'successCount') or '0')
local failedCount = tonumber(redis.call('HGET', KEYS[1], 'failedCount') or '0')
local completedJobs = successCount + failedCount

-- 4. 모든 Job 완료 여부 반환
if completedJobs >= totalJobs then
  return {1, successCount, failedCount, totalJobs}  -- 전이 가능
end

return {0, successCount, failedCount, totalJobs}  -- 아직 진행 중
```

### Lua 스크립트: transition_status.lua

분산락 내에서 상태 전이를 원자적으로 수행한다.

```lua
-- KEYS[1]: ${prefix}group:{groupId}:meta  (RedisKeyBuilder.groupMeta)
-- ARGV[1]: 기대 현재 상태 (from)
-- ARGV[2]: 전이할 상태 (to)
-- ARGV[3]: 현재 시각

-- 1. 현재 상태 확인 (Optimistic Lock)
local currentStatus = redis.call('HGET', KEYS[1], 'status')

if currentStatus ~= ARGV[1] then
  return {0, currentStatus}  -- 이미 다른 상태로 전이됨
end

-- 2. 상태 전이
redis.call('HSET', KEYS[1], 'status', ARGV[2])

-- 3. 전이 시각 기록
if ARGV[2] == 'AGGREGATING' then
  redis.call('HSET', KEYS[1], 'aggregationStartAt', ARGV[3])
elseif ARGV[2] == 'COMPLETED' or ARGV[2] == 'FAILED' then
  redis.call('HSET', KEYS[1], 'completedAt', ARGV[3])
end

return {1, ARGV[2]}  -- 전이 성공
```

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/src/
├── aggregator/
│   ├── AggregatorInterface.ts                # Aggregator<T, R> 인터페이스
│   ├── AggregatorService.ts                  # 집계 실행 서비스
│   ├── AggregatorService.spec.ts             # 집계 테스트
│   ├── DefaultAggregator.ts                  # 기본 카운트 기반 Aggregator
│   └── AggregatorConstants.ts                # 상수 정의
├── watcher/
│   ├── WatcherService.ts                     # 상태 전이 감시 서비스
│   ├── WatcherService.spec.ts                # Watcher 테스트
│   ├── StateMachine.ts                       # 상태 전이 규칙 정의
│   └── StateMachine.spec.ts                  # 상태 머신 테스트
├── lock/
│   ├── DistributedLockService.ts             # Redis 기반 분산락
│   └── DistributedLockService.spec.ts        # 분산락 테스트
├── config/
│   └── BulkActionConfig.ts                   # aggregator, watcher 설정 추가 (기존 파일 확장)
└── lua/
    ├── record-job-result.lua                 # Job 결과 기록 + 전이 조건 확인
    ├── transition-status.lua                 # 상태 전이
    ├── acquire-lock.lua                      # 분산락 획득
    └── release-lock.lua                      # 분산락 해제 (소유자 확인 후 삭제)
```

### LuaScriptLoader 확장

`LuaScriptLoader.onModuleInit()`에 Step 5 스크립트를 등록한다:

```typescript
// 기존 Step 1~3 스크립트 (8개) + Step 5 추가 (4개)
await this.loadScript('recordJobResult', 'record-job-result.lua', 2);
await this.loadScript('transitionStatus', 'transition-status.lua', 1);
await this.loadScript('acquireLock', 'acquire-lock.lua', 1);
await this.loadScript('releaseLock', 'release-lock.lua', 1);
```

> `callCommand('recordJobResult', keys, args)` 형태로 호출된다.
> RedisKeyBuilder에서 생성한 full key를 KEYS로 전달하므로, Lua 내부에서 prefix를 조합할 필요 없다.

### 설정 확장

**`config/BulkActionConfig.ts`** (Step 4에서 확장)

```typescript
// ── 신규 인터페이스 ──

export interface AggregatorConfig {
  resultRetentionMs: number; // 최종 결과 보관 기간 (default: 7일)
  failedDetailsMaxCount: number; // 실패 상세 최대 보관 수 (default: 10000)
}

export interface WatcherConfig {
  intervalMs: number; // 감시 주기 (default: 5000)
  groupTimeoutMs: number; // 그룹 전체 타임아웃 (default: 3600000 = 1시간)
  lockTtlMs: number; // 분산락 TTL (default: 10000)
  lockRetryCount: number; // 분산락 재시도 횟수 (default: 3)
  lockRetryDelayMs: number; // 분산락 재시도 간격 (default: 100)
  staleGroupThresholdMs: number; // 비활성 그룹 판정 기준 (default: 300000 = 5분)
}

// ── 기존 BulkActionConfig 확장 ──

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;
  aggregator: AggregatorConfig; // ← Step 5 추가
  watcher: WatcherConfig; // ← Step 5 추가
}

// ── 기본값 ──

export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  resultRetentionMs: 7 * 24 * 60 * 60 * 1000,
  failedDetailsMaxCount: 10000,
};

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  intervalMs: 5000,
  groupTimeoutMs: 3600000,
  lockTtlMs: 10000,
  lockRetryCount: 3,
  lockRetryDelayMs: 100,
  staleGroupThresholdMs: 300000,
};
```

> ⚠️ **기존 테스트 갱신 필요:** BulkActionConfig에 `aggregator`, `watcher` 필드가 추가되므로, 기존 테스트에서 config 객체를 생성하는 부분에 해당 필드를 추가해야 한다.

`BulkActionModule.register()` 시그니처도 확장한다:

```typescript
static register(
  config: { redis: BulkActionRedisConfig } & {
    fairQueue?: Partial<FairQueueConfig>;
    backpressure?: Partial<BackpressureConfig>;
    congestion?: Partial<CongestionConfig>;
    workerPool?: Partial<WorkerPoolConfig>;
    aggregator?: Partial<AggregatorConfig>;   // ← Step 5 추가
    watcher?: Partial<WatcherConfig>;         // ← Step 5 추가
  },
): DynamicModule {
  const mergedConfig: BulkActionConfig = {
    // ... 기존 필드 생략
    aggregator: {
      ...DEFAULT_AGGREGATOR_CONFIG,
      ...config.aggregator,
    },
    watcher: {
      ...DEFAULT_WATCHER_CONFIG,
      ...config.watcher,
    },
  };
  // ...
}
```

---

## 구현 코드

### Aggregator 인터페이스

**`aggregator/AggregatorInterface.ts`**

```typescript
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';

/**
 * MapReduce 기반 결과 집계 인터페이스.
 *
 * @typeparam T - Map 단계 출력 (중간 결과)
 * @typeparam R - Reduce 단계 출력 (최종 결과)
 *
 * 각 벌크액션 유형은 이 인터페이스를 구현하여
 * 작업 유형에 맞는 집계 로직을 제공한다.
 */
export interface Aggregator<T = unknown, R = unknown> {
  /**
   * 작업 유형을 반환한다.
   * JobProcessor.type과 매칭하여 적절한 Aggregator를 선택한다.
   */
  readonly type: string;

  /**
   * Map 단계: 개별 Job 결과를 중간 결과로 변환한다.
   *
   * Job ACK 시마다 호출되어 Redis에 Incremental로 저장된다.
   */
  map(jobResult: JobProcessorResponse): T;

  /**
   * Reduce 단계: 중간 결과 목록을 최종 결과로 집약한다.
   *
   * 모든 Job 완료 후 AGGREGATING 단계에서 1회 호출된다.
   */
  reduce(mappedResults: T[], context: AggregationContext): R;

  /**
   * 선택적: Incremental 카운터 키를 정의한다.
   * Job ACK 시 Redis HINCRBY로 실시간 갱신할 필드를 지정한다.
   */
  incrementalCounters?(): IncrementalCounter[];
}

export interface AggregationContext {
  groupId: string;
  totalJobs: number;
  successCount: number;
  failedCount: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface IncrementalCounter {
  field: string; // Redis Hash 필드명
  extract: (result: JobProcessorResponse) => number; // 결과에서 값 추출
}

export const AGGREGATOR = Symbol('AGGREGATOR');
```

### Default Aggregator

**`aggregator/DefaultAggregator.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import {
  Aggregator,
  AggregationContext,
  IncrementalCounter,
} from './AggregatorInterface';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';

/**
 * 기본 Aggregator.
 * 성공/실패 카운트와 실패 상세 목록을 집계한다.
 * 별도 Aggregator를 등록하지 않은 작업 유형에 사용된다.
 */
export interface DefaultMapResult {
  success: boolean;
  jobId: string;
  error?: string;
  durationMs: number;
}

export interface DefaultReduceResult {
  total: number;
  success: number;
  failed: number;
  successRate: string;
  avgDurationMs: number;
  totalDurationMs: number;
  failedJobs: Array<{ jobId: string; error: string }>;
}

@Injectable()
export class DefaultAggregator
  implements Aggregator<DefaultMapResult, DefaultReduceResult>
{
  readonly type = '__default__';

  map(jobResult: JobProcessorResponse): DefaultMapResult {
    return {
      success: jobResult.success,
      jobId: jobResult.jobId,
      error: jobResult.error?.message,
      durationMs: jobResult.durationMs,
    };
  }

  reduce(
    mappedResults: DefaultMapResult[],
    context: AggregationContext,
  ): DefaultReduceResult {
    const failed = mappedResults.filter((r) => !r.success);
    const totalDuration = mappedResults.reduce(
      (sum, r) => sum + r.durationMs,
      0,
    );

    return {
      total: context.totalJobs,
      success: context.successCount,
      failed: context.failedCount,
      successRate:
        ((context.successCount / context.totalJobs) * 100).toFixed(2) + '%',
      avgDurationMs:
        mappedResults.length > 0
          ? Math.round(totalDuration / mappedResults.length)
          : 0,
      totalDurationMs: context.durationMs,
      failedJobs: failed.map((f) => ({
        jobId: f.jobId,
        error: f.error ?? 'unknown',
      })),
    };
  }

  incrementalCounters(): IncrementalCounter[] {
    return [{ field: 'totalDurationMs', extract: (r) => r.durationMs }];
  }
}
```

### State Machine

**`watcher/StateMachine.ts`**

```typescript
import { GroupStatus } from '../model/job-group/type/GroupStatus';

export interface TransitionRule {
  from: GroupStatus;
  to: GroupStatus;
  condition: string; // 사람 읽기용 조건 설명
  requiresLock: boolean; // 분산락 필요 여부
}

/**
 * 그룹 상태 전이 규칙을 정의한다.
 * 허용되지 않은 전이는 거부된다.
 */
export class StateMachine {
  private static readonly transitions: TransitionRule[] = [
    {
      from: GroupStatus.CREATED,
      to: GroupStatus.DISPATCHED,
      condition: 'registeredJobs == totalJobs',
      requiresLock: false,
    },
    {
      from: GroupStatus.DISPATCHED,
      to: GroupStatus.RUNNING,
      condition: 'firstJobStartedAt > 0',
      requiresLock: false,
    },
    {
      from: GroupStatus.RUNNING,
      to: GroupStatus.AGGREGATING,
      condition: 'successCount + failedCount == totalJobs',
      requiresLock: true,
    },
    {
      from: GroupStatus.AGGREGATING,
      to: GroupStatus.COMPLETED,
      condition: 'aggregation finished',
      requiresLock: true,
    },
    {
      from: GroupStatus.CREATED,
      to: GroupStatus.FAILED,
      condition: 'timeout or unrecoverable error',
      requiresLock: true,
    },
    {
      from: GroupStatus.DISPATCHED,
      to: GroupStatus.FAILED,
      condition: 'timeout or unrecoverable error',
      requiresLock: true,
    },
    {
      from: GroupStatus.RUNNING,
      to: GroupStatus.FAILED,
      condition: 'timeout or unrecoverable error',
      requiresLock: true,
    },
  ];

  /**
   * 전이가 유효한지 확인한다.
   */
  static isValidTransition(from: GroupStatus, to: GroupStatus): boolean {
    return this.transitions.some((t) => t.from === from && t.to === to);
  }

  /**
   * 특정 전이에 분산락이 필요한지 확인한다.
   */
  static requiresLock(from: GroupStatus, to: GroupStatus): boolean {
    const rule = this.transitions.find((t) => t.from === from && t.to === to);
    return rule?.requiresLock ?? true; // 기본: 락 필요
  }

  /**
   * 특정 상태에서 가능한 다음 상태 목록을 반환한다.
   */
  static getNextStates(from: GroupStatus): GroupStatus[] {
    return this.transitions.filter((t) => t.from === from).map((t) => t.to);
  }

  /**
   * 터미널 상태(더 이상 전이 불가)인지 확인한다.
   */
  static isTerminal(status: GroupStatus): boolean {
    return status === GroupStatus.COMPLETED || status === GroupStatus.FAILED;
  }
}
```

### Distributed Lock Service

**`lock/DistributedLockService.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * 분산락을 획득한다.
   *
   * @returns 락 토큰 (해제 시 필요). null이면 획득 실패.
   */
  async acquire(lockKey: string): Promise<string | null> {
    const token = randomUUID();
    const { lockTtlMs, lockRetryCount, lockRetryDelayMs } = this.config.watcher;
    const ttlSec = Math.ceil(lockTtlMs / 1000);

    for (let attempt = 0; attempt <= lockRetryCount; attempt++) {
      // SET NX EX는 RedisService 래퍼에 없으므로 Lua 스크립트(acquireLock)로 대체
      const result = await this.redisService.callCommand(
        'acquireLock',
        [lockKey],
        [token, ttlSec.toString()],
      );

      if (result === 1) {
        this.logger.debug(`Lock acquired: ${lockKey}`);

        return token;
      }

      if (attempt < lockRetryCount) {
        await this.sleep(lockRetryDelayMs);
      }
    }

    this.logger.debug(`Lock acquisition failed: ${lockKey}`);

    return null;
  }

  /**
   * 분산락을 해제한다.
   * 소유자 확인 후 해제하여 다른 인스턴스의 락을 실수로 해제하지 않는다.
   */
  async release(lockKey: string, token: string): Promise<boolean> {
    // releaseLock Lua 스크립트: 소유자 확인 후 삭제
    const result = await this.redisService.callCommand(
      'releaseLock',
      [lockKey],
      [token],
    );
    const released = result === 1;

    if (released) {
      this.logger.debug(`Lock released: ${lockKey}`);
    } else {
      this.logger.warn(
        `Lock release failed (not owner or expired): ${lockKey}`,
      );
    }

    return released;
  }

  /**
   * 락을 획득하고, 콜백을 실행한 후, 락을 해제한다.
   * 콜백 실행 중 오류가 발생해도 락은 해제된다.
   */
  async withLock<T>(
    lockKey: string,
    callback: () => Promise<T>,
  ): Promise<T | null> {
    const token = await this.acquire(lockKey);
    if (!token) return null;

    try {
      return await callback();
    } finally {
      await this.release(lockKey, token);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### Aggregator Service

**`aggregator/AggregatorService.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import {
  Aggregator,
  AggregationContext,
  AGGREGATOR,
} from './AggregatorInterface';
import { DefaultAggregator } from './DefaultAggregator';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

/**
 * ⚠️ Step 5에서 JobProcessorResponse 인터페이스 확장이 필요하다.
 * model/job-processor/dto/JobProcessorResponse.ts에 `processorType` 필드를 추가한다:
 *
 *   export interface JobProcessorResponse {
 *     jobId: string;
 *     groupId: string;
 *     processorType?: string;  // ← 추가: Job.processorType에서 복사. Aggregator 매칭에 사용
 *     success: boolean;
 *     data?: unknown;
 *     error?: { message: string; code?: string; retryable: boolean };
 *     durationMs: number;
 *   }
 *
 * Worker에서 JobProcessorResponse 생성 시:
 *   result.processorType = job.processorType;
 */
export interface RecordResult {
  recorded: boolean;
  isGroupComplete: boolean;
  successCount: number;
  failedCount: number;
  totalJobs: number;
}

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);
  private readonly aggregatorMap = new Map<string, Aggregator>();
  private readonly defaultAggregator = new DefaultAggregator();

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    @Inject(AGGREGATOR) private readonly aggregators: Aggregator[],
    private readonly keys: RedisKeyBuilder,
  ) {
    for (const agg of aggregators) {
      this.aggregatorMap.set(agg.type, agg);
      this.logger.log(`Registered aggregator: ${agg.type}`);
    }
  }

  /**
   * Job 결과를 기록하고, 그룹 완료 여부를 반환한다.
   *
   * Worker의 handleJobComplete()에서 호출된다.
   * Lua 스크립트로 원자적으로:
   *   1. 성공/실패 카운터 증가
   *   2. 결과 상세 저장
   *   3. 전이 조건 확인
   *
   * ⚠️ 시그니처 통일:
   * JobResult에 이미 groupId가 포함되어 있으므로 별도 인자로 받지 않는다.
   * Step 4의 handleJobComplete()에서 `aggregator.recordJobResult(result)` 형태로 호출한다.
   * 이전 시그니처 `recordJobResult(groupId, jobResult)`를 사용하는 코드가 있다면
   * `recordJobResult(jobResult)` 로 변경해야 한다.
   */
  async recordJobResult(
    jobResult: JobProcessorResponse,
  ): Promise<RecordResult> {
    const groupId = jobResult.groupId;
    const metaKey = this.keys.groupMeta(groupId);
    const resultType = jobResult.success ? 'success' : 'failed';
    const resultListKey = jobResult.success
      ? this.keys.groupJobResults(groupId)
      : this.keys.groupFailedDetails(groupId);

    // Aggregator의 map() 실행
    const aggregator = this.getAggregator(jobResult);
    const mappedResult = aggregator.map(jobResult);
    const resultJson = JSON.stringify(mappedResult);

    // Lua 스크립트로 원자적 기록
    const result = await this.redisService.callCommand(
      'recordJobResult',
      [metaKey, resultListKey],
      [resultType, resultJson, Date.now().toString()],
    );

    const isGroupComplete = result[0] === 1;
    const successCount = result[1];
    const failedCount = result[2];
    const totalJobs = result[3];

    // 실패 상세 개수 제한
    if (!jobResult.success) {
      await this.trimFailedDetails(groupId);
    }

    return {
      recorded: true,
      isGroupComplete,
      successCount,
      failedCount,
      totalJobs,
    };
  }

  /**
   * 최종 집계를 수행한다.
   *
   * RUNNING → AGGREGATING 전이 후 호출된다.
   * 분산락 내에서 실행되어야 한다.
   */
  async aggregate(groupId: string, processorType: string): Promise<unknown> {
    const metaKey = this.keys.groupMeta(groupId);
    const resultKey = this.keys.groupResult(groupId);
    const successResultsKey = this.keys.groupJobResults(groupId);
    const failedDetailsKey = this.keys.groupFailedDetails(groupId);

    // 1. 메타데이터 조회
    const meta = await this.redisService.hash.getAll(metaKey);
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const successCount = parseInt(meta.successCount ?? '0', 10);
    const failedCount = parseInt(meta.failedCount ?? '0', 10);
    const startedAt = parseInt(meta.firstJobStartedAt ?? '0', 10);
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;

    // 2. 중간 결과 로드
    // ⚠️ 대량 데이터 메모리 문제:
    // LRANGE(0, -1)은 모든 결과를 한번에 메모리에 로드한다.
    // 10만 건 × 1KB JSON ≈ 100MB → Redis 전송 + Node.js 파싱에 수십 초 소요.
    // 페이지네이션으로 배치 로드하여 메모리 사용량을 제한한다.
    const BATCH_SIZE = 5000;
    const allMappedResults: unknown[] = [];

    for (const key of [successResultsKey, failedDetailsKey]) {
      let offset = 0;
      while (true) {
        const batch = await this.redisService.list.range(
          key,
          offset,
          offset + BATCH_SIZE - 1,
        );
        if (batch.length === 0) break;

        for (const item of batch) {
          allMappedResults.push(JSON.parse(item));
        }

        offset += batch.length;
        if (batch.length < BATCH_SIZE) break;
      }
    }

    // 3. Aggregator의 reduce() 실행
    const aggregator =
      this.aggregatorMap.get(processorType) ?? this.defaultAggregator;
    const context: AggregationContext = {
      groupId,
      totalJobs,
      successCount,
      failedCount,
      startedAt,
      completedAt,
      durationMs,
    };

    const finalResult = aggregator.reduce(allMappedResults, context);

    // 4. 최종 결과 저장 (각 필드를 개별 HSET으로 저장)
    const fields: Record<string, string> = {
      total: totalJobs.toString(),
      success: successCount.toString(),
      failed: failedCount.toString(),
      durationMs: durationMs.toString(),
      startedAt: startedAt.toString(),
      completedAt: completedAt.toString(),
      customData: JSON.stringify(finalResult),
    };

    for (const [field, value] of Object.entries(fields)) {
      await this.redisService.hash.set(resultKey, field, value);
    }

    this.logger.log(
      `Aggregation complete: group=${groupId}, ` +
        `total=${totalJobs}, success=${successCount}, failed=${failedCount}, ` +
        `duration=${durationMs}ms`,
    );

    return finalResult;
  }

  /**
   * 집계 결과를 조회한다.
   */
  async getResult(groupId: string): Promise<Record<string, string> | null> {
    const resultKey = this.keys.groupResult(groupId);
    const result = await this.redisService.hash.getAll(resultKey);

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * 그룹의 현재 진행률을 반환한다.
   */
  async getProgress(groupId: string): Promise<GroupProgress> {
    const meta = await this.redisService.hash.getAll(
      this.keys.groupMeta(groupId),
    );
    const total = parseInt(meta.totalJobs ?? '0', 10);
    const success = parseInt(meta.successCount ?? '0', 10);
    const failed = parseInt(meta.failedCount ?? '0', 10);
    const completed = success + failed;

    return {
      groupId,
      status: meta.status ?? 'UNKNOWN',
      total,
      completed,
      success,
      failed,
      remaining: total - completed,
      progressPercent:
        total > 0 ? parseFloat(((completed / total) * 100).toFixed(2)) : 0,
    };
  }

  // --- Private helpers ---

  /**
   * JobResult에 맞는 Aggregator를 반환한다.
   *
   * ⚠️ JobProcessorResponse 인터페이스에 processorType 필드가 필요하다.
   * Worker가 작업 실행 후 JobProcessorResponse를 생성할 때
   * Job.processorType을 result.processorType에 복사해야 한다.
   *
   * 매칭 실패 시 DefaultAggregator를 반환하므로,
   * 커스텀 Aggregator를 등록하지 않은 작업 유형도 기본 집계가 수행된다.
   */
  private getAggregator(jobResult: JobProcessorResponse): Aggregator {
    if (jobResult.processorType) {
      const aggregator = this.aggregatorMap.get(jobResult.processorType);
      if (aggregator) return aggregator;
    }

    return this.defaultAggregator;
  }

  /**
   * 실패 상세 목록을 최대 개수로 제한한다.
   */
  private async trimFailedDetails(groupId: string): Promise<void> {
    const key = this.keys.groupFailedDetails(groupId);
    const max = this.config.aggregator.failedDetailsMaxCount;
    await this.redisService.list.trim(key, -max, -1);
  }
}

export interface GroupProgress {
  groupId: string;
  status: string;
  total: number;
  completed: number;
  success: number;
  failed: number;
  remaining: number;
  progressPercent: number;
}
```

### Watcher Service

**`watcher/WatcherService.ts`**

```typescript
import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { DistributedLockService } from '../lock/DistributedLockService';
import { AggregatorService } from '../aggregator/AggregatorService';
import { StateMachine } from './StateMachine';
import { GroupStatus } from '../model/job-group/type/GroupStatus';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private isWatching = false;

  private stats = {
    totalCycles: 0,
    totalTransitions: 0,
    totalTimeouts: 0,
    totalLockFailures: 0,
  };

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly lockService: DistributedLockService,
    private readonly aggregatorService: AggregatorService,
    private readonly keys: RedisKeyBuilder,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(
      () => this.watchCycle(),
      this.config.watcher.intervalMs,
    );

    this.logger.log(
      `Watcher started (interval=${this.config.watcher.intervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.log('Watcher stopped');
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  // --- Private ---

  /**
   * 1회 감시 사이클을 실행한다.
   */
  private async watchCycle(): Promise<void> {
    if (this.isWatching) return;
    this.isWatching = true;

    try {
      this.stats.totalCycles++;

      // 1. 활성(비터미널) 그룹 목록 조회
      const activeGroups = await this.redisService.set.members(
        this.keys.watcherActiveGroups(),
      );

      for (const groupId of activeGroups) {
        await this.checkGroup(groupId);
      }
    } catch (error) {
      this.logger.error(`Watch cycle failed: ${error.message}`, error.stack);
    } finally {
      this.isWatching = false;
    }
  }

  /**
   * 개별 그룹의 상태를 점검하고, 전이 조건이 충족되면 전이를 수행한다.
   */
  private async checkGroup(groupId: string): Promise<void> {
    const meta = await this.redisService.hash.getAll(
      this.keys.groupMeta(groupId),
    );
    if (!meta.status) return;

    const status = meta.status as GroupStatus;

    // 터미널 상태면 감시 목록에서 제거
    if (StateMachine.isTerminal(status)) {
      await this.redisService.set.remove(
        this.keys.watcherActiveGroups(),
        groupId,
      );
      return;
    }

    // 타임아웃 확인
    const isTimedOut = await this.checkTimeout(groupId, meta);
    if (isTimedOut) return;

    // 상태별 전이 조건 확인
    switch (status) {
      case GroupStatus.CREATED:
        await this.checkCreatedToDispatched(groupId, meta);
        break;
      case GroupStatus.DISPATCHED:
        await this.checkDispatchedToRunning(groupId, meta);
        break;
      case GroupStatus.RUNNING:
        await this.checkRunningToAggregating(groupId, meta);
        break;
      case GroupStatus.AGGREGATING:
        await this.checkAggregatingToCompleted(groupId, meta);
        break;
    }
  }

  /**
   * CREATED → DISPATCHED: 모든 Job이 등록되었는지 확인
   */
  private async checkCreatedToDispatched(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const registeredJobs = parseInt(meta.registeredJobs ?? '0', 10);

    if (registeredJobs >= totalJobs && totalJobs > 0) {
      await this.transition(
        groupId,
        GroupStatus.CREATED,
        GroupStatus.DISPATCHED,
      );
    }
  }

  /**
   * DISPATCHED → RUNNING: 첫 Job이 실행을 시작했는지 확인
   */
  private async checkDispatchedToRunning(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const firstJobStartedAt = parseInt(meta.firstJobStartedAt ?? '0', 10);

    if (firstJobStartedAt > 0) {
      await this.transition(
        groupId,
        GroupStatus.DISPATCHED,
        GroupStatus.RUNNING,
      );
    }
  }

  /**
   * RUNNING → AGGREGATING: 모든 Job이 완료되었는지 확인
   */
  private async checkRunningToAggregating(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const successCount = parseInt(meta.successCount ?? '0', 10);
    const failedCount = parseInt(meta.failedCount ?? '0', 10);

    if (successCount + failedCount >= totalJobs && totalJobs > 0) {
      const lockKey = this.keys.groupTransitionLock(groupId);

      const result = await this.lockService.withLock(lockKey, async () => {
        // 락 획득 후 다시 상태 확인 (Double-check)
        const currentStatus = await this.redisService.hash.get(
          this.keys.groupMeta(groupId),
          'status',
        );
        if (currentStatus !== GroupStatus.RUNNING) return false;

        // 상태 전이
        await this.transition(
          groupId,
          GroupStatus.RUNNING,
          GroupStatus.AGGREGATING,
        );

        // ⚠️ aggregate() 예외 처리:
        // aggregate()가 실패하면 상태가 AGGREGATING에 멈춘다.
        // checkAggregatingToCompleted()에서 staleThreshold 이후 재시도하지만,
        // 즉시 RUNNING으로 롤백하는 것이 더 안전하다.
        try {
          const processorType = meta.processorType ?? '__default__';
          await this.aggregatorService.aggregate(groupId, processorType);

          // 집계 완료 → COMPLETED
          await this.transition(
            groupId,
            GroupStatus.AGGREGATING,
            GroupStatus.COMPLETED,
          );
        } catch (aggregateError) {
          this.logger.error(
            `Aggregation failed for group ${groupId}: ${aggregateError.message}. ` +
              `Reverting to RUNNING. checkAggregatingToCompleted()에서 재시도된다.`,
            aggregateError.stack,
          );
          // AGGREGATING → RUNNING 롤백은 StateMachine에 정의되지 않으므로
          // forceTransition 대신 meta를 직접 복원한다.
          // 다음 Watcher 사이클에서 다시 RUNNING → AGGREGATING을 시도한다.
          await this.redisService.hash.set(
            this.keys.groupMeta(groupId),
            'status',
            GroupStatus.RUNNING,
          );
        }

        return true;
      });

      if (result === null) {
        this.stats.totalLockFailures++;
      }
    }
  }

  /**
   * AGGREGATING → COMPLETED: 집계가 이미 완료되었는지 확인
   * (집계 중 실패한 경우 재시도)
   */
  private async checkAggregatingToCompleted(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const aggregationStartAt = parseInt(meta.aggregationStartAt ?? '0', 10);
    const staleThreshold = this.config.watcher.staleGroupThresholdMs;

    // 집계가 오래 걸리면 재시도
    if (
      aggregationStartAt > 0 &&
      Date.now() - aggregationStartAt > staleThreshold
    ) {
      this.logger.warn(`Stale aggregation detected: group=${groupId}`);

      const lockKey = this.keys.groupAggregationLock(groupId);
      await this.lockService.withLock(lockKey, async () => {
        const processorType = meta.processorType ?? '__default__';
        await this.aggregatorService.aggregate(groupId, processorType);
        await this.transition(
          groupId,
          GroupStatus.AGGREGATING,
          GroupStatus.COMPLETED,
        );
      });
    }
  }

  /**
   * 타임아웃 확인.
   * 그룹 생성 후 timeoutMs를 초과하면 FAILED로 전이한다.
   */
  private async checkTimeout(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    const createdAt = parseInt(meta.createdAt ?? '0', 10);
    const timeoutMs = this.config.watcher.groupTimeoutMs;

    if (createdAt > 0 && Date.now() - createdAt > timeoutMs) {
      const status = meta.status as GroupStatus;
      if (!StateMachine.isTerminal(status)) {
        this.logger.warn(
          `Group ${groupId} timed out (status=${status}, ` +
            `age=${Date.now() - createdAt}ms, timeout=${timeoutMs}ms)`,
        );

        const lockKey = this.keys.groupTransitionLock(groupId);
        await this.lockService.withLock(lockKey, async () => {
          await this.forceTransition(groupId, GroupStatus.FAILED);
        });

        this.stats.totalTimeouts++;
        return true;
      }
    }

    return false;
  }

  /**
   * 상태 전이를 수행한다.
   */
  private async transition(
    groupId: string,
    from: GroupStatus,
    to: GroupStatus,
  ): Promise<boolean> {
    if (!StateMachine.isValidTransition(from, to)) {
      this.logger.error(
        `Invalid transition: ${from} → ${to} for group ${groupId}`,
      );
      return false;
    }

    const result = await this.redisService.callCommand(
      'transitionStatus',
      [this.keys.groupMeta(groupId)],
      [from, to, Date.now().toString()],
    );

    const success = result[0] === 1;

    if (success) {
      this.stats.totalTransitions++;
      this.logger.log(`Group ${groupId}: ${from} → ${to}`);
    } else {
      this.logger.debug(
        `Transition skipped: group=${groupId}, expected=${from}, actual=${result[1]}`,
      );
    }

    return success;
  }

  /**
   * 강제 상태 전이 (타임아웃 등).
   *
   * ⚠️ transition_status.lua 대신 HMSET을 사용하는 이유:
   * 타임아웃 시 현재 상태가 무엇이든 강제로 FAILED로 전이해야 하기 때문.
   * 단, 이미 터미널 상태(COMPLETED/FAILED)인 그룹을 다시 전이하면
   * 완료된 결과가 훼손되므로, 터미널 상태 방어를 추가한다.
   */
  private async forceTransition(
    groupId: string,
    to: GroupStatus,
  ): Promise<void> {
    // ✅ 터미널 상태 방어: 이미 완료/실패된 그룹은 강제 전이하지 않는다.
    const currentStatus = await this.redisService.hash.get(
      this.keys.groupMeta(groupId),
      'status',
    );
    if (
      currentStatus &&
      StateMachine.isTerminal(currentStatus as GroupStatus)
    ) {
      this.logger.debug(
        `Force transition skipped: group=${groupId} is already terminal (${currentStatus})`,
      );
      await this.redisService.set.remove(
        this.keys.watcherActiveGroups(),
        groupId,
      );

      return;
    }

    await this.redisService.hash.set(
      this.keys.groupMeta(groupId),
      'status',
      to,
    );
    await this.redisService.hash.set(
      this.keys.groupMeta(groupId),
      'completedAt',
      Date.now().toString(),
    );

    this.stats.totalTransitions++;
    this.logger.warn(`Group ${groupId}: FORCE ${currentStatus} → ${to}`);

    // 감시 목록에서 제거
    if (StateMachine.isTerminal(to)) {
      await this.redisService.set.remove(
        this.keys.watcherActiveGroups(),
        groupId,
      );
    }
  }
}
```

### 모듈 등록

**`BulkActionModule.ts`** (Step 4에서 확장)

```typescript
import { DynamicModule, Module } from '@nestjs/common';
// ... 기존 import 생략
import { AggregatorService } from './aggregator/AggregatorService';
import { DefaultAggregator } from './aggregator/DefaultAggregator';
import { AGGREGATOR } from './aggregator/AggregatorInterface';
import { WatcherService } from './watcher/WatcherService';
import { DistributedLockService } from './lock/DistributedLockService';

@Module({})
export class BulkActionModule {
  static register(config?: Partial<BulkActionConfig>): DynamicModule {
    const mergedConfig = this.mergeConfig(config);

    return {
      module: BulkActionModule,
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: mergedConfig },
        RedisKeyBuilder,
        LuaScriptLoader,
        // Step 1
        FairQueueService,
        // Step 2
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        BackpressureService,
        // Step 3
        CongestionControlService,
        CongestionStatsService,
        // Step 4
        FetcherService,
        DispatcherService,
        WorkerPoolService,
        // Step 5
        DistributedLockService,
        AggregatorService,
        WatcherService,
        DefaultAggregator,
        // 기본 Aggregator를 AGGREGATOR 토큰으로 등록
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator) => [defaultAgg],
          inject: [DefaultAggregator],
        },
      ],
      exports: [
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        WorkerPoolService,
        AggregatorService,
        DistributedLockService,
      ],
    };
  }

  /**
   * 커스텀 Aggregator를 등록한다.
   *
   * ⚠️ DefaultAggregator 보존:
   * register()에서 AGGREGATOR 토큰에 [DefaultAggregator]를 등록하는데,
   * registerAggregators()가 AGGREGATOR 토큰을 덮어쓰면 DefaultAggregator가 소실된다.
   * 이를 방지하기 위해 registerAggregators()에서 DefaultAggregator를 항상 포함시킨다.
   *
   * AggregatorService.getAggregator()는 type 매칭 실패 시 defaultAggregator를 반환하므로,
   * AGGREGATOR 토큰 목록에 DefaultAggregator가 없어도 map()은 동작한다.
   * 하지만 AggregatorService 생성자에서 aggregatorMap에 등록되지 않으므로
   * incrementalCounters() 등 DefaultAggregator 고유 기능이 누락될 수 있다.
   *
   * 사용법:
   *   BulkActionModule.registerAggregators([
   *     PromotionAggregator,
   *     CustomerUploadAggregator,
   *   ])
   */
  static registerAggregators(aggregators: any[]): DynamicModule {
    return {
      module: BulkActionModule,
      providers: [
        DefaultAggregator,
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator, ...customs: any[]) => [
            defaultAgg,
            ...customs,
          ],
          inject: [DefaultAggregator, ...aggregators],
        },
        ...aggregators,
      ],
      exports: [AGGREGATOR],
    };
  }

  // ... mergeConfig 생략
}
```

### 사용 예시: 커스텀 Aggregator

**`apps/api/src/promotion/promotion.aggregator.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import {
  Aggregator,
  AggregationContext,
} from '@app/bulk-action/aggregator/AggregatorInterface';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';

interface PromotionMapResult {
  targetId: string;
  sent: boolean;
  channel: string; // 'sms' | 'push' | 'email'
  error?: string;
}

interface PromotionReduceResult {
  total: number;
  sent: number;
  failed: number;
  byChannel: Record<string, { sent: number; failed: number }>;
  failedTargets: string[];
  successRate: string;
  durationMs: number;
}

@Injectable()
export class PromotionAggregator
  implements Aggregator<PromotionMapResult, PromotionReduceResult>
{
  readonly type = 'SEND_PROMOTION';

  map(jobResult: JobProcessorResponse): PromotionMapResult {
    const data = jobResult.data as any;
    return {
      targetId: data?.targetId ?? jobResult.jobId,
      sent: jobResult.success,
      channel: data?.channel ?? 'unknown',
      error: jobResult.error?.message,
    };
  }

  reduce(
    results: PromotionMapResult[],
    context: AggregationContext,
  ): PromotionReduceResult {
    const byChannel: Record<string, { sent: number; failed: number }> = {};
    const failedTargets: string[] = [];

    for (const r of results) {
      if (!byChannel[r.channel]) {
        byChannel[r.channel] = { sent: 0, failed: 0 };
      }
      if (r.sent) {
        byChannel[r.channel].sent++;
      } else {
        byChannel[r.channel].failed++;
        failedTargets.push(r.targetId);
      }
    }

    return {
      total: context.totalJobs,
      sent: context.successCount,
      failed: context.failedCount,
      byChannel,
      failedTargets: failedTargets.slice(0, 1000), // 최대 1000건
      successRate:
        ((context.successCount / context.totalJobs) * 100).toFixed(2) + '%',
      durationMs: context.durationMs,
    };
  }
}
```

**모듈 등록:**

```typescript
@Module({
  imports: [
    BulkActionModule.register({
      /* ... */
    }),
    BulkActionModule.registerProcessors([PromotionProcessor]),
    BulkActionModule.registerAggregators([PromotionAggregator]),
  ],
})
export class ApiModule {}
```

---

## Step 1~4와의 연동

### Worker 완료 콜백 확장

Step 4의 `WorkerPoolService.handleJobComplete()`에 Aggregator 연동을 추가한다.

```typescript
// WorkerPoolService.ts 변경

constructor(
  // ... 기존 의존성
  private readonly aggregatorService: AggregatorService,
) {}

private async handleJobComplete(result: JobProcessorResponse): Promise<void> {
  try {
    // 1. ★ 결과 기록 (Aggregator map + successCount/failedCount 갱신)
    //    doneJobs는 건드리지 않음 — ack.lua가 전담
    const recordResult = await this.aggregatorService.recordJobResult(result);

    // 2. Fair Queue ACK (Step 1) — doneJobs 증가 + 그룹 완료 판정
    const isGroupCompleted = await this.fairQueue.ack(result.jobId, result.groupId);

    // 3. 그룹 완료 시 후처리
    if (isGroupCompleted) {
      await this.congestionControl.resetGroupStats(result.groupId);
      this.logger.log(
        `Group ${result.groupId} all jobs completed. ` +
        `Watcher will handle RUNNING → AGGREGATING transition.`,
      );
    }
  } catch (error) {
    this.logger.error(
      `Failed to handle job completion: ${(error as Error).message}`,
      (error as Error).stack,
    );
  }
}
```

### 전체 데이터 흐름

```
┌─────────────────────────────────────────────────────────────────────┐
│ 벌크액션 전체 생애주기                                                │
│                                                                     │
│ Client                                                              │
│   │ "고객 1만 명에게 프로모션 발송"                                    │
│   ▼                                                                 │
│ enqueue × 10,000 ──▶ Fair Queue (Step 1)                            │
│   │                    그룹 상태: CREATED                             │
│   │                         │                                       │
│   │  (registeredJobs == totalJobs)                                  │
│   │                         ▼                                       │
│   │                    Watcher: CREATED → DISPATCHED                 │
│   │                         │                                       │
│   │                    Fetcher (Step 4)                              │
│   │                    → Rate Limit (Step 2)                        │
│   │                    → Congestion (Step 3)                        │
│   │                         │                                       │
│   │                    Worker (Step 4)                               │
│   │                    → process() 시작                              │
│   │                         │                                       │
│   │  (firstJobStartedAt > 0)                                       │
│   │                         ▼                                       │
│   │                    Watcher: DISPATCHED → RUNNING                 │
│   │                         │                                       │
│   │                    Worker 완료                                   │
│   │                    → aggregator.recordJobResult() ── Step 5 ★   │
│   │                    → fairQueue.ack()                             │
│   │                         │                                       │
│   │  (successCount + failedCount == totalJobs)                      │
│   │                         ▼                                       │
│   │                    Watcher + Lock: RUNNING → AGGREGATING        │
│   │                    → aggregator.aggregate() 실행                 │
│   │                    → reduce() 최종 결과 산출                      │
│   │                         │                                       │
│   │                    Watcher: AGGREGATING → COMPLETED              │
│   │                         │                                       │
│   │                         ▼                                       │
│   │                    최종 결과 Redis에 저장                          │
│   │                                                                 │
│   ▼                                                                 │
│ Client: aggregator.getResult(groupId)                               │
│   → { total: 10000, success: 9500, failed: 500, ... }              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 진행률 조회 API 예시

```typescript
@Controller('bulk-actions')
export class BulkActionController {
  constructor(private readonly aggregator: AggregatorService) {}

  @Get(':groupId/progress')
  async getProgress(@Param('groupId') groupId: string): Promise<GroupProgress> {
    return this.aggregator.getProgress(groupId);
  }

  @Get(':groupId/result')
  async getResult(@Param('groupId') groupId: string) {
    const result = await this.aggregator.getResult(groupId);
    if (!result) {
      throw new NotFoundException(`Result not found for group ${groupId}`);
    }
    return result;
  }
}
```

```json
// GET /bulk-actions/customer-A/progress
{
  "groupId": "customer-A",
  "status": "RUNNING",
  "total": 10000,
  "completed": 7500,
  "success": 7200,
  "failed": 300,
  "remaining": 2500,
  "progressPercent": 75.0
}
```

---

## 테스트 전략

### StateMachine 단위 테스트

```typescript
describe('StateMachine', () => {
  it('유효한 전이를 허용한다', () => {
    expect(
      StateMachine.isValidTransition(
        GroupStatus.CREATED,
        GroupStatus.DISPATCHED,
      ),
    ).toBe(true);
    expect(
      StateMachine.isValidTransition(
        GroupStatus.RUNNING,
        GroupStatus.AGGREGATING,
      ),
    ).toBe(true);
    expect(
      StateMachine.isValidTransition(
        GroupStatus.AGGREGATING,
        GroupStatus.COMPLETED,
      ),
    ).toBe(true);
  });

  it('유효하지 않은 전이를 거부한다', () => {
    expect(
      StateMachine.isValidTransition(
        GroupStatus.CREATED,
        GroupStatus.COMPLETED,
      ),
    ).toBe(false);
    expect(
      StateMachine.isValidTransition(
        GroupStatus.COMPLETED,
        GroupStatus.RUNNING,
      ),
    ).toBe(false);
    expect(
      StateMachine.isValidTransition(
        GroupStatus.AGGREGATING,
        GroupStatus.RUNNING,
      ),
    ).toBe(false);
  });

  it('모든 비터미널 상태에서 FAILED로 전이 가능하다', () => {
    expect(
      StateMachine.isValidTransition(GroupStatus.CREATED, GroupStatus.FAILED),
    ).toBe(true);
    expect(
      StateMachine.isValidTransition(
        GroupStatus.DISPATCHED,
        GroupStatus.FAILED,
      ),
    ).toBe(true);
    expect(
      StateMachine.isValidTransition(GroupStatus.RUNNING, GroupStatus.FAILED),
    ).toBe(true);
  });

  it('COMPLETED와 FAILED는 터미널 상태다', () => {
    expect(StateMachine.isTerminal(GroupStatus.COMPLETED)).toBe(true);
    expect(StateMachine.isTerminal(GroupStatus.FAILED)).toBe(true);
    expect(StateMachine.isTerminal(GroupStatus.RUNNING)).toBe(false);
  });

  it('RUNNING → AGGREGATING은 분산락이 필요하다', () => {
    expect(
      StateMachine.requiresLock(GroupStatus.RUNNING, GroupStatus.AGGREGATING),
    ).toBe(true);
    expect(
      StateMachine.requiresLock(GroupStatus.CREATED, GroupStatus.DISPATCHED),
    ).toBe(false);
  });
});
```

### DistributedLockService 통합 테스트

```typescript
describe('DistributedLockService (Integration)', () => {
  let lockService: DistributedLockService;
  let redisService: RedisService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          watcher: { lockTtlMs: 2000, lockRetryCount: 2, lockRetryDelayMs: 50 },
        }),
      ],
    }).compile();

    lockService = module.get(DistributedLockService);
    redisService = module.get(RedisService);
  });

  afterEach(async () => {
    await redisService.flushDatabase();
  });

  it('락을 획득하고 해제할 수 있다', async () => {
    const token = await lockService.acquire('test-lock');
    expect(token).not.toBeNull();

    const released = await lockService.release('test-lock', token!);
    expect(released).toBe(true);
  });

  it('이미 획득된 락은 다른 요청이 획득할 수 없다', async () => {
    const token1 = await lockService.acquire('test-lock');
    expect(token1).not.toBeNull();

    const token2 = await lockService.acquire('test-lock');
    expect(token2).toBeNull(); // 획득 실패

    await lockService.release('test-lock', token1!);
  });

  it('다른 소유자의 락을 해제할 수 없다', async () => {
    const token = await lockService.acquire('test-lock');
    expect(token).not.toBeNull();

    const released = await lockService.release('test-lock', 'wrong-token');
    expect(released).toBe(false);

    // 원래 토큰으로는 해제 가능
    await lockService.release('test-lock', token!);
  });

  it('TTL 후 자동으로 만료된다', async () => {
    const token = await lockService.acquire('test-lock');
    expect(token).not.toBeNull();

    // TTL 대기 (2초 + 여유)
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 다른 요청이 획득 가능
    const token2 = await lockService.acquire('test-lock');
    expect(token2).not.toBeNull();

    await lockService.release('test-lock', token2!);
  }, 5000);

  it('withLock이 콜백을 실행하고 락을 해제한다', async () => {
    let executed = false;

    const result = await lockService.withLock('test-lock', async () => {
      executed = true;
      return 'done';
    });

    expect(executed).toBe(true);
    expect(result).toBe('done');

    // 락이 해제되어 재획득 가능
    const token = await lockService.acquire('test-lock');
    expect(token).not.toBeNull();
    await lockService.release('test-lock', token!);
  });

  it('withLock에서 오류 발생 시에도 락이 해제된다', async () => {
    await expect(
      lockService.withLock('test-lock', async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    // 락이 해제되어 재획득 가능
    const token = await lockService.acquire('test-lock');
    expect(token).not.toBeNull();
    await lockService.release('test-lock', token!);
  });
});
```

### AggregatorService 통합 테스트

```typescript
describe('AggregatorService (Integration)', () => {
  let aggregator: AggregatorService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
        }),
      ],
    }).compile();

    aggregator = module.get(AggregatorService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);
  });

  afterEach(async () => {
    await redisService.flushDatabase();
  });

  it('Job 결과를 기록하고 카운터를 갱신한다', async () => {
    // given - 그룹 메타데이터 초기화
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'totalJobs', '3');
    await redisService.hash.set(metaKey, 'successCount', '0');
    await redisService.hash.set(metaKey, 'failedCount', '0');
    await redisService.hash.set(metaKey, 'status', 'RUNNING');

    // 성공 결과 기록
    const result = await aggregator.recordJobResult({
      jobId: 'j1',
      groupId: 'g1',
      success: true,
      durationMs: 100,
    });

    expect(result.recorded).toBe(true);
    expect(result.isGroupComplete).toBe(false);
    expect(result.successCount).toBe(1);
  });

  it('마지막 Job 완료 시 isGroupComplete=true를 반환한다', async () => {
    // given
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'totalJobs', '2');
    await redisService.hash.set(metaKey, 'successCount', '0');
    await redisService.hash.set(metaKey, 'failedCount', '0');
    await redisService.hash.set(metaKey, 'status', 'RUNNING');

    await aggregator.recordJobResult({
      jobId: 'j1',
      groupId: 'g1',
      success: true,
      durationMs: 100,
    });

    const result = await aggregator.recordJobResult({
      jobId: 'j2',
      groupId: 'g1',
      success: false,
      error: { message: 'timeout', retryable: false },
      durationMs: 200,
    });

    expect(result.isGroupComplete).toBe(true);
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it('aggregate()가 최종 결과를 생성한다', async () => {
    // given
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'totalJobs', '3');
    await redisService.hash.set(metaKey, 'successCount', '2');
    await redisService.hash.set(metaKey, 'failedCount', '1');
    await redisService.hash.set(metaKey, 'status', 'AGGREGATING');
    await redisService.hash.set(
      metaKey,
      'firstJobStartedAt',
      (Date.now() - 5000).toString(),
    );

    await redisService.list.append(
      keys.groupJobResults('g1'),
      JSON.stringify({ success: true, jobId: 'j1', durationMs: 100 }),
    );
    await redisService.list.append(
      keys.groupJobResults('g1'),
      JSON.stringify({ success: true, jobId: 'j2', durationMs: 150 }),
    );
    await redisService.list.append(
      keys.groupFailedDetails('g1'),
      JSON.stringify({
        success: false,
        jobId: 'j3',
        error: 'timeout',
        durationMs: 200,
      }),
    );

    await aggregator.aggregate('g1', '__default__');

    const result = await aggregator.getResult('g1');
    expect(result).not.toBeNull();
    expect(result!.total).toBe('3');
    expect(result!.success).toBe('2');
    expect(result!.failed).toBe('1');
  });

  it('getProgress()가 실시간 진행률을 반환한다', async () => {
    // given
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'totalJobs', '100');
    await redisService.hash.set(metaKey, 'successCount', '70');
    await redisService.hash.set(metaKey, 'failedCount', '5');
    await redisService.hash.set(metaKey, 'status', 'RUNNING');

    const progress = await aggregator.getProgress('g1');
    expect(progress.total).toBe(100);
    expect(progress.completed).toBe(75);
    expect(progress.remaining).toBe(25);
    expect(progress.progressPercent).toBe(75.0);
  });
});
```

### Watcher 통합 테스트

```typescript
describe('WatcherService (Integration)', () => {
  let watcher: WatcherService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          watcher: { intervalMs: 100, groupTimeoutMs: 3000 },
        }),
      ],
    }).compile();

    watcher = module.get(WatcherService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);

    // 자동 시작 방지
    watcher.stop();
  });

  afterEach(async () => {
    await redisService.flushDatabase();
  });

  it('모든 Job 등록 완료 시 CREATED → DISPATCHED 전이', async () => {
    // given
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'status', 'CREATED');
    await redisService.hash.set(metaKey, 'totalJobs', '5');
    await redisService.hash.set(metaKey, 'registeredJobs', '5');
    await redisService.hash.set(metaKey, 'createdAt', Date.now().toString());
    await redisService.set.add(keys.watcherActiveGroups(), 'g1');

    // when - 수동으로 1회 사이클 실행 (private 메서드이므로 start/stop으로 테스트)
    watcher.start();
    await sleep(200);
    watcher.stop();

    // then
    const status = await redisService.hash.get(keys.groupMeta('g1'), 'status');
    expect(status).toBe('DISPATCHED');
  });

  it('타임아웃 초과 시 FAILED로 전이', async () => {
    // given
    const metaKey = keys.groupMeta('g1');
    await redisService.hash.set(metaKey, 'status', 'RUNNING');
    await redisService.hash.set(metaKey, 'totalJobs', '100');
    await redisService.hash.set(metaKey, 'successCount', '50');
    await redisService.hash.set(metaKey, 'failedCount', '0');
    await redisService.hash.set(
      metaKey,
      'createdAt',
      (Date.now() - 5000).toString(),
    ); // 5초 전 생성 (timeout=3초)
    await redisService.set.add(keys.watcherActiveGroups(), 'g1');

    // when
    watcher.start();
    await sleep(200);
    watcher.stop();

    // then
    const status = await redisService.hash.get(keys.groupMeta('g1'), 'status');
    expect(status).toBe('FAILED');
  });

  it('터미널 상태인 그룹을 감시 목록에서 제거한다', async () => {
    // given
    await redisService.hash.set(keys.groupMeta('g1'), 'status', 'COMPLETED');
    await redisService.set.add(keys.watcherActiveGroups(), 'g1');

    // when
    watcher.start();
    await sleep(200);
    watcher.stop();

    // then
    const members = await redisService.set.members(keys.watcherActiveGroups());
    expect(members).not.toContain('g1');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 운영 고려사항

### 모니터링 지표

```
# Watcher 상태
bulk_action_watcher_cycles_total                      # 감시 사이클 수
bulk_action_watcher_transitions_total{from, to}       # 상태 전이 수
bulk_action_watcher_timeouts_total                    # 타임아웃 수
bulk_action_watcher_lock_failures_total               # 분산락 획득 실패 수

# Aggregator 성능
bulk_action_aggregator_record_duration_ms             # 결과 기록 지연 (histogram)
bulk_action_aggregator_aggregate_duration_ms           # 최종 집계 지연 (histogram)

# 그룹 상태 분포
bulk_action_group_status{status="CREATED|DISPATCHED|RUNNING|AGGREGATING|COMPLETED|FAILED"}

# 진행률
bulk_action_group_progress{groupId="..."}             # 0~100
```

### 설정 튜닝 가이드

| 설정                               | 기본값    | 조정 기준                                                 |
| ---------------------------------- | --------- | --------------------------------------------------------- |
| `watcher.intervalMs`               | 5,000     | 그룹 수가 적으면 낮추기. 많으면 높여서 Redis 부하 감소    |
| `watcher.groupTimeoutMs`           | 3,600,000 | 가장 큰 벌크 요청의 예상 처리시간 × 2                     |
| `watcher.lockTtlMs`                | 10,000    | 집계 최대 소요시간 × 2                                    |
| `watcher.staleGroupThresholdMs`    | 300,000   | 집계 실패 탐지 임계값                                     |
| `aggregator.resultRetentionMs`     | 7일       | 클라이언트가 결과를 조회하는 최대 기간                    |
| `aggregator.failedDetailsMaxCount` | 10,000    | 메모리 제약에 따라 조정. 10만 건 실패 시 전부 저장 불필요 |

### 장애 시나리오 대응

| 시나리오              | 증상                      | 대응                                                    |
| --------------------- | ------------------------- | ------------------------------------------------------- |
| 집계 중 인스턴스 다운 | AGGREGATING에 멈춤        | Watcher의 stale 탐지 → 재집계                           |
| 분산락 교착           | 락 TTL 이내 인스턴스 다운 | TTL 만료로 자동 해소                                    |
| 중복 전이 시도        | 두 인스턴스가 동시에 전이 | transition_status.lua의 상태 검증으로 방지              |
| 결과 데이터 유실      | Redis 재시작              | AOF/RDB 백업 설정. 결과는 재집계 가능                   |
| 매우 큰 결과 목록     | LRANGE 지연               | failedDetailsMaxCount 제한, 페이지네이션 조회           |
| Watcher 과부하        | 활성 그룹 수천 개         | intervalMs 증가, 그룹별 체크를 분산 (그룹 ID 해시 기반) |

### 데이터 정리 (Cleanup)

완료된 그룹의 데이터는 주기적으로 정리해야 한다.

```typescript
// CronService 또는 별도 스크립트
async cleanupCompletedGroups(olderThanMs: number): Promise<number> {
  // 1. COMPLETED 또는 FAILED 그룹 중 completedAt < (now - olderThanMs) 찾기
  // 2. 관련 키 삭제:
  //    - group:{id}:meta
  //    - group:{id}:result
  //    - group:{id}:job-results
  //    - group:{id}:failed-details
  //    - congestion:{id}:*
  // 3. 개별 job:{id} 키 삭제
}
```

### 후속 Step 연동 인터페이스

Step 5는 Step 4(Worker Pool)의 **결과 콜백**에서 호출되고, Step 6(Reliable Queue)에서 **추가 호출 지점**이 생긴다.

#### Step 4 Worker Pool → Step 5 연동 포인트

Step 4 보완에서 이미 `@Optional()` 주입으로 AggregatorService 연동이 추가되었다. 확인해야 할 포인트:

```typescript
// Step 4 WorkerPoolService에서 Step 5를 호출하는 지점:

// 1. handleJobComplete() — 결과 기록 후 ACK (순서 중요!)
//    ① aggregator.recordJobResult(result)  — successCount/failedCount 갱신
//    ② fairQueue.ack(jobId, groupId)       — doneJobs 증가 + 그룹 완료 판정
//    ③ 그룹 완료 시 congestionControl.resetGroupStats()
await this.aggregatorService.recordJobResult(result);
const isGroupCompleted = await this.fairQueue.ack(result.jobId, result.groupId);

// 2. handleDeadLetter() — Dead Letter 실패도 집계 반영 (ACK 전에 호출!)
//    ① aggregator.recordJobResult()  — failedCount 갱신
//    ② fairQueue.ack()               — doneJobs 증가 + 그룹 완료 판정
await this.aggregatorService.recordJobResult({
  jobId: job.id,
  groupId: job.groupId,
  success: false,
  error: { message: error.message, code: 'DEAD_LETTER', retryable: false },
  durationMs: 0,
});
await this.fairQueue.ack(job.id, job.groupId);
```

> `finalizeGroup()`은 Worker에서의 "힌트" 트리거이다. Watcher도 동일한 전이를 수행하므로,
> 분산락으로 중복 집계를 방지한다. AggregatorService에 추가한다:

```typescript
/**
 * 그룹 완료 시 최종 집계를 트리거한다.
 * Worker의 handleJobComplete()에서 isGroupCompleted=true일 때 호출된다.
 *
 * Watcher도 동일한 전이를 수행하므로, 이 메서드는 "힌트" 역할이다.
 * 분산락으로 중복 집계를 방지한다.
 */
async finalizeGroup(groupId: string): Promise<void> {
  const lockKey = this.keys.groupTransitionLock(groupId);

  await this.lockService.withLock(lockKey, async () => {
    const currentStatus = await this.redisService.hash.get(this.keys.groupMeta(groupId), 'status');
    if (currentStatus !== GroupStatus.RUNNING) return;

    await this.transition(groupId, GroupStatus.RUNNING, GroupStatus.AGGREGATING);

    try {
      const processorType = await this.redisService.hash.get(this.keys.groupMeta(groupId), 'processorType') ?? '__default__';
      await this.aggregate(groupId, processorType);
      await this.transition(groupId, GroupStatus.AGGREGATING, GroupStatus.COMPLETED);
    } catch (err) {
      this.logger.error(`finalizeGroup failed for ${groupId}: ${err.message}`);
      await this.redisService.hash.set(this.keys.groupMeta(groupId), 'status', GroupStatus.RUNNING);
    }
  });
}
```

#### Step 6 Reliable Queue → Step 5 연동 포인트

Step 6 적용 시 Step 5에 영향을 미치는 변경 사항:

| 위치                          | 변경 내용                                               | 이유                                                        |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `OrphanRecoveryService`       | Dead Letter 이동 시 `aggregator.recordJobResult()` 호출 | Orphan에 의한 Dead Letter도 집계에 포함                     |
| `OrphanRecoveryService`       | Ready Queue 복구 시 집계 미갱신                         | 재시도이므로 아직 결과가 없음 (올바른 동작)                 |
| `ReliableQueueService.nack()` | `aggregator.recordJobResult()` 호출 **불필요**          | NACK은 재시도 또는 Dead Letter이며, Dead Letter 시점에 기록 |
| `firstJobStartedAt` 갱신      | `reliableQueue.blockingDequeue()` 성공 시 갱신          | DISPATCHED → RUNNING 전이 조건                              |

```typescript
// Step 6 OrphanRecoveryService에서 Dead Letter 이동 시 Step 5 연동:
// recover_orphans.lua의 deadLettered 목록을 반환받아 집계에 반영

const { recovered, deadLettered, deadLetteredJobIds } =
  await this.recoveryCycle();

// Dead Letter된 작업을 Step 5 Aggregator에 실패로 기록
if (this.aggregator && deadLetteredJobIds.length > 0) {
  for (const jobId of deadLetteredJobIds) {
    await this.aggregator.recordJobResult({
      jobId,
      groupId: '', // Job Hash에서 조회 필요
      processorType: '',
      success: false,
      error: {
        message: 'Orphan recovery: max retries exceeded',
        code: 'ORPHAN_DEAD_LETTER',
        retryable: false,
      },
      durationMs: 0,
    });
  }
}
```

### 다음 단계

Step 5까지 구현되면 벌크액션의 **결과 가시성**이 확보된다. 클라이언트는 진행률을 실시간으로 확인하고, 완료 후 집계 결과를 조회할 수 있다.

남은 Step 6(Reliable Queue + ACK)은 Worker가 작업을 가져간 후 비정상 종료할 때 **작업 유실을 방지**하는 마지막 안전장치이다.

```
Step 1~4: 공정하게 분배 → 속도 제어 → 병렬 실행
Step 5:   결과 집계 + 상태 관리 + 모니터링
Step 6:   At-least-once 보장 (In-flight 작업 복구)
```

### 문서 갱신 히스토리

#### 1. 2026-02-04

```
#: 1
이슈: recordJobResult() 시그니처 불일치
수정 내용: 2인자 → 1인자로 통일. JobProcessorResponse.groupId에서 추출. 테스트 코드도 함께 수정
────────────────────────────────────────
#: 2
이슈: getAggregator() 항상 default 반환
수정 내용: JobProcessorResponse.jobType 필드 기반 매칭 구현. JobProcessorResponse 인터페이스 확장 가이드 추가
────────────────────────────────────────
#: 3
이슈: Step 1 doneJobs 이중 카운팅
수정 내용: record_job_result.lua에서 doneJobs도 함께 HINCRBY. Step 1 ack()에서 제거 가이드
────────────────────────────────────────
#: 4
이슈: aggregate() 예외 시 AGGREGATING 영구 멈춤
수정 내용: try-catch 추가, 예외 시 RUNNING으로 롤백하여 다음 사이클에서 재시도
────────────────────────────────────────
#: 5
이슈: forceTransition() 터미널 상태 검증 우회
수정 내용: HMSET 전에 현재 상태 확인, 이미 COMPLETED/FAILED면 스킵
────────────────────────────────────────
#: 6
이슈: AGGREGATOR 토큰 DefaultAggregator 소실
수정 내용: registerAggregators()에서 DefaultAggregator를 항상 포함하여 inject
────────────────────────────────────────
#: 7
이슈: aggregate() LRANGE 전체 로드 메모리 문제
수정 내용: BATCH_SIZE=5000 페이지네이션으로 배치 로드
────────────────────────────────────────
#: 8
이슈: 후속 Step 연동 인터페이스 부재
수정 내용: finalizeGroup() 메서드 추가, Step 4 연동 3개 지점, Step 6 Orphan Recovery 연동 테이블 및 코드 예시
```

#### 2. 2026-02-20

```
실제 코드베이스(libs/bulk-action/)와의 불일치 9개 항목 일괄 정정

[Critical]
#: 9
이슈: record_job_result.lua에서 doneJobs HINCRBY → ack.lua와 이중 카운팅
수정 내용: record_job_result.lua에서 doneJobs HINCRBY 제거, ack.lua가 doneJobs 전담 관리로 역할 분리
────────────────────────────────────────
#: 10
이슈: 문서 전반 @Inject(REDIS_CLIENT) redis: Redis 사용 — 실제는 RedisService
수정 내용: 모든 서비스에서 RedisService 주입으로 변경. redis.set()/hgetall()/hmset()/eval() 등 raw 호출을 redisService.hash.getAll()/set()/callCommand() 등 래퍼로 전환. 테스트 코드도 RedisService 사용으로 통일
────────────────────────────────────────
#: 11
이슈: barrel export import 경로 ('../model/job', '../model/job-result' 등)
수정 내용: 실제 파일 경로로 변경 ('../model/job/Job', '../model/job-processor/dto/JobProcessorResponse' 등). 파일명 PascalCase 적용. config/bulk-action.config → config/BulkActionConfig

[Major]
#: 12
이슈: JobProcessorResponse에 jobType 필드명 — 실제는 processorType
수정 내용: 문서 전반 jobType → processorType으로 변경. Aggregator 매칭, Worker 복사 가이드 모두 통일
────────────────────────────────────────
#: 13
이슈: BulkActionConfig 확장 — 인터페이스명 및 기본값 미정의
수정 내용: AggregatorConfig, WatcherConfig 인터페이스 분리. DEFAULT_AGGREGATOR_CONFIG, DEFAULT_WATCHER_CONFIG 기본값 정의. BulkActionModule.register() 시그니처 확장 가이드 추가. 기존 테스트 갱신 필요 고지
────────────────────────────────────────
#: 14
이슈: handleJobComplete() 호출 순서 불명확
수정 내용: ① recordJobResult() → ② fairQueue.ack() → ③ 그룹 완료 시 resetGroupStats() 순서로 정정. congestionControl 호출 추가
────────────────────────────────────────
#: 15
이슈: Dead Letter 경로에서 recordJobResult() 호출 누락
수정 내용: handleDeadLetter()에서 ack() 전에 recordJobResult() 호출하도록 Step 4 연동 코드 수정
────────────────────────────────────────
#: 16
이슈: RedisKeyBuilder에 Step 5용 키 메서드 미정의
수정 내용: groupResult, groupJobResults, groupFailedDetails, groupTransitionLock, groupAggregationLock, watcherActiveGroups 메서드 추가 코드 블록 삽입
────────────────────────────────────────
#: 17
이슈: Lua 스크립트 키 프리픽스 주석 부정확 + LuaScriptLoader 등록 누락
수정 내용: record_job_result.lua, transition_status.lua 주석을 ${prefix}group:{groupId}:meta 형태로 변경. LuaScriptLoader에 recordJobResult, transitionStatus, acquireLock, releaseLock 등록 코드 추가
```
