# Step 6. 실패 처리 (Reliable Queue + ACK)

> At-least-once semantic 보장

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [메시지 전달 보장 수준](#메시지-전달-보장-수준)
3. [In-flight Queue 설계](#in-flight-queue-설계)
4. [ACK 메커니즘](#ack-메커니즘)
5. [Orphaned Job 복구](#orphaned-job-복구)
6. [멱등성 (Idempotency)](#멱등성-idempotency)
7. [Redis 데이터 구조 설계](#redis-데이터-구조-설계)
8. [NestJS 모듈 구조](#nestjs-모듈-구조)
9. [구현 코드](#구현-코드)
10. [Step 1~5와의 연동](#step-15와의-연동)
11. [테스트 전략](#테스트-전략)
12. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### Step 4의 한계: 작업 유실 구간

Step 4에서 Worker는 Ready Queue에서 `LPOP`으로 작업을 꺼내 실행한다. 이 과정에서 **작업이 유실되는 구간**이 존재한다.

```
정상 흐름:
  Ready Queue ──LPOP──▶ Worker ──처리──▶ ACK

유실 구간:
  Ready Queue ──LPOP──▶ Worker ──[인스턴스 크래시]──▶ ???
                                       │
                            작업이 Ready Queue에도 없고
                            완료도 안 됨 = 영구 유실
```

| 유실 시나리오 | 발생 시점 | 결과 |
|-------------|----------|------|
| 인스턴스 크래시 | Worker가 작업 실행 중 프로세스 종료 | 작업 유실 |
| OOM Kill | 메모리 초과로 OS가 프로세스 강제 종료 | 작업 유실 |
| 네트워크 단절 | Worker → Redis 연결 끊김 후 ACK 실패 | 작업 유실 또는 중복 |
| 무한 루프/행 | 작업이 영원히 끝나지 않음 | 사실상 유실 |
| Graceful Shutdown 실패 | 종료 대기시간 초과 후 강제 종료 | 실행 중 작업 유실 |

### Reliable Queue 패턴

Reliable Queue는 **작업이 성공적으로 처리되었음을 확인(ACK)할 때까지 작업을 안전하게 보관**하는 패턴이다.

```
기존 (Unreliable):
  Ready Queue ──LPOP──▶ Worker
  (pop하면 큐에서 사라짐)

Reliable Queue:
  Ready Queue ──RPOPLPUSH──▶ In-flight Queue ──▶ Worker
  (pop하면 In-flight로 이동)        │
                                    │ ACK 수신
                                    ▼
                              In-flight에서 제거
                              (작업 완료 확정)

                                    │ ACK 미수신 (timeout)
                                    ▼
                              Ready Queue로 복구
                              (재처리)
```

핵심 아이디어: **작업은 반드시 어딘가에 존재**한다. Ready Queue 또는 In-flight Queue 둘 중 하나에 항상 있으므로 유실되지 않는다.

---

## 메시지 전달 보장 수준

### 3가지 전달 보장

| 보장 수준 | 설명 | 구현 난이도 | 적용 |
|----------|------|-----------|------|
| **At-most-once** | 최대 1번. 유실 가능, 중복 없음 | 낮음 (단순 LPOP) | Step 4까지의 구현 |
| **At-least-once** | 최소 1번. 유실 없음, 중복 가능 | 중간 (Reliable Queue) | **Step 6 목표** |
| **Exactly-once** | 정확히 1번. 유실 없음, 중복 없음 | 높음 (트랜잭션 필요) | 이론적으로 불가능에 가까움 |

### At-least-once 선택 이유

```
At-most-once (기존):
  - 100만 건 중 1,000건 유실 → 고객에게 프로모션 미발송
  - 비즈니스 영향: 매출 손실

At-least-once (Step 6):
  - 100만 건 중 일부 중복 발송 가능 → 같은 고객에게 2번 발송
  - 비즈니스 영향: 약간의 불편 (멱등성으로 최소화 가능)

Exactly-once:
  - 분산 시스템에서 완벽 구현 불가능 (Two Generals' Problem)
  - At-least-once + 멱등성으로 실질적 Exactly-once 효과 달성
```

벌크액션에서는 **유실보다 중복이 낫다**. 중복은 멱등성으로 해결할 수 있지만, 유실은 복구할 수 없다.

### At-least-once + 멱등성 = 실질적 Exactly-once

```
시나리오: 프로모션 발송

Worker A: job-123 실행 → SMS 발송 성공 → [크래시] → ACK 못 보냄
  ↓
Orphan 복구: job-123 → Ready Queue 복구
  ↓
Worker B: job-123 재실행 → SMS 발송 시도
  ↓
멱등성 체크: "이미 발송된 targetId" → 스킵 (실제 중복 발송 안 됨)
  ↓
ACK 전송 → 완료
```

---

## In-flight Queue 설계

### 개념

In-flight Queue는 **Worker가 가져갔지만 아직 완료 확인(ACK)을 받지 못한 작업**을 추적한다.

```
┌─────────────────────────────────────────────────────┐
│                    작업의 위치                        │
│                                                     │
│  Fair Queue    Ready Queue    In-flight    완료      │
│  ┌──────┐     ┌──────┐      ┌──────┐    ┌──────┐  │
│  │대기중│────▶│실행대기│─────▶│실행중│───▶│완료됨│  │
│  └──────┘     └──────┘      └──────┘    └──────┘  │
│                     ▲            │                  │
│                     │   timeout  │                  │
│                     └────────────┘                  │
│                     (orphan 복구)                    │
│                                                     │
│  ★ 작업은 반드시 이 4곳 중 하나에 존재               │
└─────────────────────────────────────────────────────┘
```

### Redis Sorted Set 활용

In-flight Queue는 Redis Sorted Set으로 구현한다. **score는 ACK 타임아웃 시각(deadline)**이다.

```
Key: bulk-action:in-flight-queue
Type: Sorted Set
┌───────────────────────┬──────────────┐
│ score (deadline)      │ member       │
├───────────────────────┼──────────────┤
│ 1706000030000         │ job-001      │  ← 30초 후 타임아웃
│ 1706000031000         │ job-005      │
│ 1706000032000         │ job-012      │
│ 1706000035000         │ job-023      │  ← 35초 후 타임아웃
└───────────────────────┴──────────────┘

score <= now인 작업 = 타임아웃 = orphaned job
```

### Pop + In-flight 등록의 원자성

Ready Queue에서 pop하는 동시에 In-flight Queue에 등록하는 연산은 **반드시 원자적**이어야 한다. 두 연산 사이에 크래시가 발생하면 작업이 유실된다.

```
비원자적 (위험):
  1. LPOP ready-queue → job-001
  2. [크래시 발생]
  3. ZADD in-flight-queue ... job-001  ← 실행 안 됨
  → job-001 유실

원자적 (안전):
  Lua 스크립트로 1+2를 하나의 명령으로 실행
  → 둘 다 실행되거나 둘 다 실행 안 됨
```

---

## ACK 메커니즘

### ACK 흐름

```
Worker                     In-flight Queue              Ready Queue
  │                             │                           │
  │  reliable_dequeue()         │                           │
  │  (Lua: LPOP + ZADD)        │                           │
  │────────────────────────────▶│                           │
  │  job-001                    │                           │
  │◀────────────────────────────│                           │
  │                             │                           │
  │  process(job-001)           │                           │
  │  ┌────────┐                 │                           │
  │  │ 실행중 │                 │ score = now + timeout     │
  │  └────────┘                 │ (countdown 진행 중)       │
  │                             │                           │
  ├── 성공 시 ────────────────▶ │                           │
  │  ack(job-001)               │                           │
  │  → ZREM in-flight job-001   │                           │
  │                             │                           │
  ├── 실패 시 ────────────────▶ │                           │
  │  nack(job-001)              │                           │
  │  → ZREM in-flight           │                           │
  │  → RPUSH ready-queue        │ ─────────────────────────▶│
  │     (또는 Non-ready Queue)  │                           │
  │                             │                           │
  ├── 타임아웃 시 ──────────────│                           │
  │  (아무 응답 없음)            │ score <= now 감지         │
  │                             │──── 복구 ────────────────▶│
  │                             │ ZREM + RPUSH              │
  │                             │                           │
```

### ACK / NACK / Timeout 비교

| 응답 | 의미 | In-flight 처리 | 다음 행선지 |
|------|------|---------------|-----------|
| **ACK** | 작업 성공 완료 | ZREM (제거) | 없음 (완료) |
| **NACK** | 작업 실패, 재시도 필요 | ZREM (제거) | Non-ready Queue (backoff) 또는 Ready Queue |
| **Timeout** | Worker 응답 없음 (크래시 추정) | ZREM (제거) | Ready Queue (즉시 재시도) |

### Visibility Timeout 패턴

AWS SQS에서 차용한 패턴이다. 작업을 꺼내면 일정 시간 동안 **다른 Worker에게 보이지 않으며**, 그 시간 내에 ACK를 보내야 한다.

```
시간축:
  t=0     Worker가 job-001 dequeue
          In-flight에 등록 (deadline = t+30s)
          다른 Worker에게 job-001은 보이지 않음

  t=10    Worker가 처리 중...

  t=20    Worker 처리 완료, ACK 전송
          In-flight에서 job-001 제거 ✓

  ─── 정상 완료 ───

  t=0     Worker가 job-001 dequeue
  t=15    Worker 크래시 발생
  t=30    Deadline 도달, ACK 미수신
          Orphan Recovery: In-flight → Ready Queue
  t=31    다른 Worker가 job-001 재처리
```

### ACK Timeout 결정 기준

```
ACK Timeout = 작업 최대 실행시간 + 네트워크 지연 + 여유

예시:
  작업 최대 실행시간: 30초 (외부 API 호출 + DB 저장)
  네트워크 지연: 1초
  여유: 9초
  → ACK Timeout = 40초

주의:
  - 너무 짧으면: 정상 실행 중인데 orphan으로 판정 → 중복 실행
  - 너무 길면: 실제 orphan 복구가 늦어짐 → 처리 지연
```

---

## Orphaned Job 복구

### Orphan이란?

Worker가 작업을 가져간 후 ACK를 보내지 못하고 사라진 작업이다.

```
Orphan 발생 원인:
  1. 인스턴스 크래시 (OOM, Segfault, Kill -9)
  2. 네트워크 파티션 (Worker ↔ Redis 연결 끊김)
  3. 무한 루프/행 (작업이 ACK Timeout을 초과)
  4. Graceful Shutdown 실패 (종료 대기시간 초과)
```

### 복구 프로세스

Orphan Recovery는 주기적으로(기본 5초) In-flight Queue를 스캔하여 deadline이 지난 작업을 복구한다.

```
Orphan Recovery 1회 사이클:

  1. ZRANGEBYSCORE in-flight-queue -inf {now}
     → deadline이 지난 작업 목록 조회

  2. 각 orphaned job에 대해:
     a. retryCount 확인
     b. retryCount < maxRetry?
        ├── yes → Ready Queue로 복구 (retryCount + 1)
        └── no  → Dead Letter Queue로 이동

  3. In-flight Queue에서 제거

전체 과정은 Lua 스크립트로 원자적 수행
```

### 복구 시 주의사항

```
문제: Worker가 느리게 실행 중인데 orphan으로 판정됨

  t=0     Worker A: job-001 dequeue (timeout=30s)
  t=25    Worker A: 아직 처리 중 (느린 외부 API)
  t=30    Recovery: job-001 orphan 판정 → Ready Queue 복구
  t=31    Worker B: job-001 dequeue → 처리 시작
  t=35    Worker A: 처리 완료 → ACK 시도
          → In-flight에 job-001이 없음 (이미 제거됨)
          → ACK 실패 (무시 가능)
  t=40    Worker B: 처리 완료 → ACK 성공

  결과: job-001이 2번 실행됨 → 멱등성으로 해결 필요
```

이 시나리오를 완전히 방지하는 것은 불가능하다 (분산 시스템의 근본적 한계). **멱등성**이 유일한 해법이다.

---

## 멱등성 (Idempotency)

### 왜 멱등성이 필요한가

At-least-once는 중복 실행을 허용한다. 중복 실행이 부작용을 일으키지 않으려면 **같은 작업을 여러 번 실행해도 결과가 동일**해야 한다.

```
멱등하지 않은 작업:
  "잔액 += 1000원"
  → 1번 실행: 잔액 11,000원 ✓
  → 2번 실행: 잔액 12,000원 ✗ (중복 적립)

멱등한 작업:
  "잔액을 11,000원으로 설정 (IF 아직 10,000원이면)"
  → 1번 실행: 잔액 11,000원 ✓
  → 2번 실행: 이미 11,000원 → 스킵 ✓
```

### 멱등성 구현 전략

벌크액션 시스템은 멱등성 보장의 **책임을 JobProcessor에 위임**한다. 시스템은 멱등성 구현을 돕는 도구를 제공한다.

**전략 1: Idempotency Key**

```typescript
// 시스템이 제공하는 헬퍼
class IdempotencyService {
  async isProcessed(idempotencyKey: string): Promise<boolean> {
    const result = await this.redis.set(
      `idempotency:${idempotencyKey}`,
      '1',
      'NX',
      'EX',
      86400, // 24시간 TTL
    );
    return result !== 'OK'; // 이미 존재하면 true (처리됨)
  }
}

// JobProcessor에서 사용
class PromotionProcessor implements JobProcessor {
  async process(job: Job): Promise<JobProcessorResponse> {
    const key = `promotion:${job.groupId}:${job.id}`;
    if (await this.idempotency.isProcessed(key)) {
      return { jobId: job.id, groupId: job.groupId, success: true, durationMs: 0 };
    }
    // ... 실제 처리
  }
}
```

**전략 2: 상태 확인 후 처리 (Conditional Write)**

```typescript
// DB 레벨 멱등성
async sendPromotion(targetId: string, promotionId: string): Promise<void> {
  // INSERT ... ON CONFLICT DO NOTHING
  const result = await this.db.query(
    `INSERT INTO promotion_log (target_id, promotion_id, sent_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (target_id, promotion_id) DO NOTHING`,
    [targetId, promotionId],
  );

  if (result.rowCount === 0) {
    // 이미 발송됨 → 스킵
    return;
  }

  // 실제 발송
  await this.smsService.send(targetId, promotionId);
}
```

**전략 3: 버전 기반 (Optimistic Lock)**

```typescript
// 버전 번호로 중복 업데이트 방지
async updateCustomer(customerId: string, data: any, version: number): Promise<void> {
  const result = await this.db.query(
    `UPDATE customers SET data = $1, version = version + 1
     WHERE id = $2 AND version = $3`,
    [data, customerId, version],
  );

  if (result.rowCount === 0) {
    // 이미 다른 실행에서 업데이트됨 → 스킵
    return;
  }
}
```

---

## Redis 데이터 구조 설계

### 추가 Key 구조

```
# In-flight Queue
bulk-action:in-flight-queue                          # Sorted Set (score = deadline)

# In-flight 작업 메타데이터
bulk-action:in-flight:{jobId}                        # Hash - 실행 정보

# Dead Letter Queue
bulk-action:dead-letter-queue                        # List - 복구 불가 작업

# 멱등성 키
bulk-action:idempotency:{key}                        # String (NX, TTL)
```

### In-flight Queue (Sorted Set)

```
Key: bulk-action:in-flight-queue
Type: Sorted Set
┌───────────────────────┬──────────────┐
│ score (ACK deadline)  │ member       │
├───────────────────────┼──────────────┤
│ 1706000040000         │ job-001      │
│ 1706000041000         │ job-005      │
│ 1706000042000         │ job-012      │
└───────────────────────┴──────────────┘
→ score <= now인 작업 = orphaned
→ Recovery가 주기적으로 ZRANGEBYSCORE(-inf, now) 스캔
```

### In-flight 작업 메타데이터 (Hash)

Worker 정보와 실행 시작 시각을 추적한다. 디버깅과 모니터링에 사용한다.

```
Key: bulk-action:in-flight:job-001
Type: Hash
┌──────────────────┬──────────────────────┐
│ field            │ value                │
├──────────────────┼──────────────────────┤
│ jobId            │ job-001              │
│ groupId          │ customer-A           │
│ workerId         │ worker-3             │
│ instanceId       │ instance-abc123      │
│ startedAt        │ 1706000010000        │
│ deadline         │ 1706000040000        │
│ retryCount       │ 1                    │
└──────────────────┴──────────────────────┘
TTL: ACK timeout + 여유 (자동 정리)
```

### Dead Letter Queue (List)

최대 재시도를 초과한 작업을 보관한다. 수동 분석 및 재처리에 사용한다.

```
Key: bulk-action:dead-letter-queue
Type: List
[
  '{"jobId":"job-001","groupId":"customer-A","error":"timeout after 3 retries","failedAt":1706000050000}',
  '{"jobId":"job-023","groupId":"customer-B","error":"API 500","failedAt":1706000060000}',
  ...
]
```

### Lua 스크립트: reliable-dequeue.lua

Ready Queue에서 pop하고 In-flight Queue에 등록하는 원자적 연산이다. Node.js에서 LINDEX로 peek한 뒤 retryCount/groupId를 Job Hash에서 pre-fetch하여 ARGV로 전달한다 (Lua 내 Job Hash 접근 회피).

> ⚠️ **Redis Cluster 해시 슬롯 주의:**
> Lua 내부에서 `KEYS[3] .. jobId` 로 동적 키를 생성하므로,
> Cluster 환경에서는 `{bulk-action}` 해시 태그를 사용해야 한다.

```lua
local readyQueueKey       = KEYS[1]  -- bulk-action:ready-queue
local inFlightQueueKey    = KEYS[2]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix  = KEYS[3]  -- bulk-action:in-flight:

local ackTimeoutMs = tonumber(ARGV[1])
local workerId     = ARGV[2]
local instanceId   = ARGV[3]
local retryCount   = ARGV[4]
local groupId      = ARGV[5]

-- 1. Ready Queue에서 작업 꺼냄
local jobId = redis.call('LPOP', readyQueueKey)
if not jobId then
  return nil
end

-- 2. deadline 계산 (현재 시각 + ackTimeoutMs)
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local deadline = nowMs + ackTimeoutMs

-- 3. In-flight Queue에 등록 (score = deadline)
redis.call('ZADD', inFlightQueueKey, deadline, jobId)

-- 4. In-flight 메타데이터 저장
local metaKey = inFlightMetaPrefix .. jobId
redis.call('HSET', metaKey,
  'jobId', jobId,
  'workerId', workerId,
  'instanceId', instanceId,
  'deadline', tostring(deadline),
  'dequeuedAt', tostring(nowMs),
  'retryCount', retryCount,
  'groupId', groupId
)

return {jobId, tostring(deadline)}
```

### Lua 스크립트: reliable-ack.lua

작업 완료 확인(ACK). `nack()`도 동일한 Lua를 재사용한다 (In-flight 제거만 수행, retry/DLQ 판정은 기존 `handleJobFailed` 담당).

```lua
local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix = KEYS[2]  -- bulk-action:in-flight:

local jobId = ARGV[1]

-- 1. In-flight Queue에서 제거
local removed = redis.call('ZREM', inFlightQueueKey, jobId)

-- 2. 메타데이터 삭제
local metaKey = inFlightMetaPrefix .. jobId
redis.call('DEL', metaKey)

-- removed=1이면 정상 ACK, 0이면 late ACK (이미 orphan recovery에 의해 제거됨)
return removed
```

### Lua 스크립트: extend-deadline.lua

ACK deadline을 원자적으로 연장한다. In-flight에 존재하는지 확인 후 갱신하여, OrphanRecovery와의 Race condition을 방지한다.

```lua
local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix = KEYS[2]  -- bulk-action:in-flight:

local jobId      = ARGV[1]
local extensionMs = tonumber(ARGV[2])

-- 1. In-flight Queue에 존재하는지 확인
local currentScore = redis.call('ZSCORE', inFlightQueueKey, jobId)
if not currentScore then
  return 0  -- 이미 제거됨 (ACK 또는 orphan recovery)
end

-- 2. 새 deadline 계산
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local newDeadline = nowMs + extensionMs

-- 3. In-flight Queue 갱신
redis.call('ZADD', inFlightQueueKey, newDeadline, jobId)

-- 4. 메타데이터 갱신
local metaKey = inFlightMetaPrefix .. jobId
redis.call('HSET', metaKey, 'deadline', tostring(newDeadline))

return 1  -- 성공
```

### Lua 스크립트: recover-orphans.lua

타임아웃된 작업을 복구한다. Dead Letter 이동 시 `{jobId, groupId}` 쌍을 반환하여 Node.js에서 Aggregator 집계 + FairQueue ACK 처리에 사용한다.

> ⚠️ **keyPrefix 주의:** Lua 내부에서 Job Hash에 접근해야 하므로,
> `keys.getPrefix() + 'job:'` 형태로 Job 키 접두사를 ARGV[4]로 전달한다.

```lua
local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local readyQueueKey      = KEYS[2]  -- bulk-action:ready-queue
local deadLetterQueueKey = KEYS[3]  -- bulk-action:dead-letter-queue
local inFlightMetaPrefix = KEYS[4]  -- bulk-action:in-flight:

local nowMs          = tonumber(ARGV[1])
local batchSize      = tonumber(ARGV[2])
local maxRetryCount  = tonumber(ARGV[3])
local jobKeyPrefix   = ARGV[4]  -- e.g. 'test:job:'

-- 1. deadline이 지난 작업 조회
local orphans = redis.call('ZRANGEBYSCORE', inFlightQueueKey, '-inf', nowMs, 'LIMIT', 0, batchSize)

if #orphans == 0 then
  return {0, 0}
end

local recovered = 0
local deadLettered = 0
local deadLetteredPairs = {}  -- {jobId1, groupId1, jobId2, groupId2, ...}

for _, jobId in ipairs(orphans) do
  -- In-flight Queue에서 제거
  redis.call('ZREM', inFlightQueueKey, jobId)

  -- 메타데이터에서 retryCount, groupId 조회
  local metaKey = inFlightMetaPrefix .. jobId
  local meta = redis.call('HGETALL', metaKey)

  local retryCount = 0
  local groupId = ''

  -- 메타데이터 파싱
  if #meta > 0 then
    for i = 1, #meta, 2 do
      if meta[i] == 'retryCount' then
        retryCount = tonumber(meta[i + 1]) or 0
      elseif meta[i] == 'groupId' then
        groupId = meta[i + 1]
      end
    end
  else
    -- 메타데이터가 없으면 Job Hash에서 fallback 조회
    local jobKey = jobKeyPrefix .. jobId
    retryCount = tonumber(redis.call('HGET', jobKey, 'retryCount') or '0')
    groupId = redis.call('HGET', jobKey, 'groupId') or ''
  end

  -- 메타데이터 삭제
  redis.call('DEL', metaKey)

  if retryCount >= maxRetryCount then
    -- DLQ로 이동
    local entry = cjson.encode({
      jobId = jobId,
      groupId = groupId,
      retryCount = retryCount,
      error = 'orphan: max retries exceeded',
      failedAt = nowMs,
    })
    redis.call('RPUSH', deadLetterQueueKey, entry)

    -- Job 상태를 FAILED로 변경
    local jobKey = jobKeyPrefix .. jobId
    redis.call('HSET', jobKey, 'status', 'FAILED')

    deadLettered = deadLettered + 1
    table.insert(deadLetteredPairs, jobId)
    table.insert(deadLetteredPairs, groupId)
  else
    -- Ready Queue로 복구, retryCount 증가
    local jobKey = jobKeyPrefix .. jobId
    redis.call('HINCRBY', jobKey, 'retryCount', 1)
    redis.call('HSET', jobKey, 'status', 'PENDING')
    redis.call('RPUSH', readyQueueKey, jobId)

    recovered = recovered + 1
  end
end

-- 반환: [recovered, deadLettered, jobId1, groupId1, jobId2, groupId2, ...]
local result = {recovered, deadLettered}
for _, v in ipairs(deadLetteredPairs) do
  table.insert(result, v)
end

return result
```

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/src/
├── reliable-queue/
│   ├── ReliableQueueService.ts              # 신뢰성 있는 큐 서비스
│   ├── InFlightQueueService.ts              # In-flight 작업 추적/모니터링
│   ├── OrphanRecoveryService.ts             # Orphaned Job 복구
│   ├── DeadLetterService.ts                 # Dead Letter 관리
│   └── DequeueResult.ts                     # Dequeue 결과 인터페이스
├── idempotency/
│   └── IdempotencyService.ts                # 멱등성 헬퍼
├── config/
│   └── BulkActionConfig.ts                  # ReliableQueueConfig 추가
├── key/
│   └── RedisKeyBuilder.ts                   # in-flight, idempotency 키 추가
└── lua/
    ├── reliable-dequeue.lua                 # 원자적 LPOP + ZADD + HSET
    ├── reliable-ack.lua                     # ZREM + DEL metadata
    ├── recover-orphans.lua                  # Orphan 스캔 → Ready Queue 복구 or DLQ
    └── extend-deadline.lua                  # 원자적 deadline 연장

libs/bulk-action/test/
├── reliable-queue/
│   ├── ReliableQueueService.spec.ts         # 통합 테스트
│   ├── InFlightQueueService.spec.ts         # In-flight 테스트
│   ├── OrphanRecoveryService.spec.ts        # 복구 테스트
│   └── DeadLetterService.spec.ts            # DLQ 테스트
└── idempotency/
    └── IdempotencyService.spec.ts           # 멱등성 테스트
```

### 설정 확장

**`config/BulkActionConfig.ts`**

```typescript
export interface ReliableQueueConfig {
  ackTimeoutMs: number;              // ACK 타임아웃 (default: 40000)
  orphanRecoveryIntervalMs: number;  // 복구 스캔 주기 (default: 5000)
  orphanRecoveryBatchSize: number;   // 1회 최대 복구 수 (default: 100)
  maxRetryCount: number;             // 최대 재시도 (default: 3)
  deadLetterRetentionMs: number;     // DLQ 보관 기간 (default: 30일)
  idempotencyTtlMs: number;          // 멱등성 키 TTL (default: 86400000 = 24시간)
  workerPollIntervalMs: number;      // Worker poll 간격 (default: 200)
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;
  aggregator: AggregatorConfig;
  watcher: WatcherConfig;
  reliableQueue: ReliableQueueConfig;
}

export const DEFAULT_RELIABLE_QUEUE_CONFIG: ReliableQueueConfig = {
  ackTimeoutMs: 40000,
  orphanRecoveryIntervalMs: 5000,
  orphanRecoveryBatchSize: 100,
  maxRetryCount: 3,
  deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  idempotencyTtlMs: 86400000, // 24h
  workerPollIntervalMs: 200,
};
```

### RedisKeyBuilder 추가 키

**`key/RedisKeyBuilder.ts`**

```typescript
// ── Reliable Queue ──
inFlightQueue(): string {
  return `${this.prefix}in-flight-queue`;
}

inFlightMeta(jobId: string): string {
  return `${this.prefix}in-flight:${jobId}`;
}

inFlightMetaPrefix(): string {
  return `${this.prefix}in-flight:`;
}

// ── Idempotency ──
idempotency(key: string): string {
  return `${this.prefix}idempotency:${key}`;
}
```

---

## 구현 코드

> 아래 코드는 실제 구현과 일치한다. 모든 Redis 접근은 `RedisService` 래퍼를 통해 이루어지며,
> 키 관리는 `RedisKeyBuilder`에 위임한다. Lua 실행은 `redisService.callCommand()`를 사용한다.

### Dequeue Result

**`reliable-queue/DequeueResult.ts`**

```typescript
export interface DequeueResult {
  jobId: string;
  deadline: number;
}
```

### In-flight Queue Service

**`reliable-queue/InFlightQueueService.ts`**

모니터링/조회 전용 서비스. `BULK_ACTION_CONFIG`를 주입하지 않는다.

```typescript
import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface InFlightEntry {
  jobId: string;
  workerId: string;
  instanceId: string;
  deadline: number;
  dequeuedAt: number;
  retryCount: number;
  groupId: string;
}

@Injectable()
export class InFlightQueueService {
  constructor(
    private readonly redisService: RedisService,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async size(): Promise<number> {
    return this.redisService.sortedSet.count(this.keys.inFlightQueue());
  }

  async isInFlight(jobId: string): Promise<boolean> {
    const score = await this.redisService.sortedSet.score(
      this.keys.inFlightQueue(),
      jobId,
    );
    return score !== null;
  }

  async orphanedCount(): Promise<number> {
    return this.redisService.sortedSet.countByScore(
      this.keys.inFlightQueue(),
      '-inf',
      Date.now().toString(),
    );
  }

  async getEntry(jobId: string): Promise<InFlightEntry | null> {
    const data = await this.redisService.hash.getAll(
      this.keys.inFlightMeta(jobId),
    );
    if (!data || !data.jobId) return null;

    return {
      jobId: data.jobId,
      workerId: data.workerId,
      instanceId: data.instanceId,
      deadline: parseInt(data.deadline, 10),
      dequeuedAt: parseInt(data.dequeuedAt, 10),
      retryCount: parseInt(data.retryCount, 10),
      groupId: data.groupId,
    };
  }

  async getAllEntries(): Promise<Array<{ jobId: string; deadline: number }>> {
    const entries = await this.redisService.sortedSet.rangeWithScores(
      this.keys.inFlightQueue(),
      0,
      -1,
    );
    return entries.map((e) => ({
      jobId: e.member,
      deadline: e.score,
    }));
  }
}
```

### Reliable Queue Service

**`reliable-queue/ReliableQueueService.ts`**

핵심 서비스. `blockingDequeue()`는 제거하고 non-blocking `dequeue()` + Worker poll+sleep 패턴을 사용한다. `nack()`은 `reliableAck` Lua를 재사용하여 In-flight 제거만 수행 — retry/DLQ 판정은 기존 `handleJobFailed`가 담당한다.

```typescript
import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { DequeueResult } from './DequeueResult';

@Injectable()
export class ReliableQueueService {
  private readonly logger = new Logger(ReliableQueueService.name);
  private readonly instanceId: string;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {
    this.instanceId = randomUUID();
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Non-blocking dequeue. Ready Queue에서 작업을 꺼내고 In-flight Queue에 등록한다.
   *
   * LINDEX로 peek → Job Hash에서 retryCount/groupId pre-fetch → Lua 원자적 LPOP+ZADD.
   * peek과 실제 LPOP이 다를 수 있으나(race), recover-orphans.lua가 메타데이터 fallback
   * 조회하므로 안전하다.
   */
  async dequeue(workerId: string): Promise<DequeueResult | null> {
    const readyQueueKey = this.keys.readyQueue();
    const length = await this.redisService.list.length(readyQueueKey);
    if (length === 0) return null;

    // Pre-fetch retryCount/groupId via LINDEX peek
    const peekResult = await this.redisService.list.range(readyQueueKey, 0, 0);
    let retryCount = '0';
    let groupId = '';

    if (peekResult.length > 0) {
      const peekJobId = peekResult[0];
      const jobKey = this.keys.job(peekJobId);
      retryCount = (await this.redisService.hash.get(jobKey, 'retryCount')) ?? '0';
      groupId = (await this.redisService.hash.get(jobKey, 'groupId')) ?? '';
    }

    const result = await this.redisService.callCommand(
      'reliableDequeue',
      [readyQueueKey, this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [this.config.reliableQueue.ackTimeoutMs.toString(), workerId, this.instanceId, retryCount, groupId],
    );

    if (!result) return null;

    const [jobId, deadline] = result as string[];
    return { jobId, deadline: parseInt(deadline, 10) };
  }

  /** @returns true면 정상 ACK, false면 late ACK (이미 orphan 복구됨) */
  async ack(jobId: string): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'reliableAck',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId],
    );
    const removed = result === 1;
    if (!removed) {
      this.logger.warn(`Late ACK for job ${jobId} (already recovered)`);
    }
    return removed;
  }

  /** In-flight 제거만 수행. retry/DLQ 판정은 WorkerPoolService.handleJobFailed()가 담당. */
  async nack(jobId: string): Promise<void> {
    await this.redisService.callCommand(
      'reliableAck',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId],
    );
  }

  /** Lua extend-deadline.lua로 원자적 deadline 연장 (heartbeat용). */
  async extendDeadline(jobId: string, extensionMs?: number): Promise<boolean> {
    const extension = extensionMs ?? this.config.reliableQueue.ackTimeoutMs;
    const result = await this.redisService.callCommand(
      'extendDeadline',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId, extension.toString()],
    );
    return result === 1;
  }
}
```

### Orphan Recovery Service

**`reliable-queue/OrphanRecoveryService.ts`**

`AggregatorService`와 `FairQueueService`를 직접 주입받아, Dead Letter 이동된 orphan에 대해 집계 + Fair Queue ACK을 수행한다. 이것이 설계 문서에서 확인된 **집계 갭**을 해결하는 핵심 로직이다.

```typescript
import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { AggregatorService } from '../aggregator/AggregatorService';
import { FairQueueService } from '../fair-queue/FairQueueService';

export interface OrphanRecoveryStats {
  totalCycles: number;
  totalRecovered: number;
  totalDeadLettered: number;
}

@Injectable()
export class OrphanRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrphanRecoveryService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private stats: OrphanRecoveryStats = {
    totalCycles: 0,
    totalRecovered: 0,
    totalDeadLettered: 0,
  };

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly aggregatorService: AggregatorService,
    private readonly fairQueue: FairQueueService,
  ) {}

  async onModuleInit(): Promise<void> { this.start(); }
  async onModuleDestroy(): Promise<void> { this.stop(); }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(
      () => void this.runOnce(),
      this.config.reliableQueue.orphanRecoveryIntervalMs,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async runOnce(): Promise<{ recovered: number; deadLettered: number }> {
    const nowMs = Date.now();
    const jobKeyPrefix = this.keys.getPrefix() + 'job:';

    const result = (await this.redisService.callCommand(
      'recoverOrphans',
      [this.keys.inFlightQueue(), this.keys.readyQueue(),
       this.keys.deadLetterQueue(), this.keys.inFlightMetaPrefix()],
      [nowMs.toString(), this.config.reliableQueue.orphanRecoveryBatchSize.toString(),
       this.config.reliableQueue.maxRetryCount.toString(), jobKeyPrefix],
    )) as number[];

    const recovered = Number(result[0]);
    const deadLettered = Number(result[1]);

    this.stats.totalCycles++;
    this.stats.totalRecovered += recovered;
    this.stats.totalDeadLettered += deadLettered;

    // deadLettered orphan 집계 처리
    if (deadLettered > 0) {
      const pairs = result.slice(2).map(String);
      await this.handleDeadLetteredOrphans(pairs);
    }

    return { recovered, deadLettered };
  }

  getStats(): OrphanRecoveryStats {
    return { ...this.stats };
  }

  /**
   * Dead Letter로 이동된 orphan에 대해:
   * 1. AggregatorService.recordJobResult()로 실패 집계
   * 2. FairQueueService.ack()로 Fair Queue 완료 처리
   * 3. 그룹 완료 시 AggregatorService.finalizeGroup()
   *
   * ⚠️ ack.lua가 항상 job status를 COMPLETED로 설정하므로,
   * recover-orphans.lua에서 설정한 FAILED 상태는 덮어씌워진다.
   */
  private async handleDeadLetteredOrphans(pairs: string[]): Promise<void> {
    for (let i = 0; i < pairs.length; i += 2) {
      const jobId = pairs[i];
      const groupId = pairs[i + 1];

      await this.aggregatorService.recordJobResult({
        jobId, groupId, success: false, durationMs: 0,
        processorType: '',
        error: { message: 'orphan: max retries exceeded', retryable: false },
      });

      const isGroupCompleted = await this.fairQueue.ack(jobId, groupId);
      if (isGroupCompleted) {
        await this.aggregatorService.finalizeGroup(groupId);
      }
    }
  }
}
```

### Dead Letter Service

**`reliable-queue/DeadLetterService.ts`**

조회/재투입/정리 전용 (DLQ 기록은 하지 않음). `removeFromDLQ()`는 전체 목록을 읽고 필터링 후 재작성하는 방식 — 소량 DLQ이므로 성능 문제 없음.

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface DeadLetterEntry {
  jobId: string;
  groupId: string;
  retryCount: number;
  error: string;
  failedAt: number;
}

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async size(): Promise<number> {
    return this.redisService.list.length(this.keys.deadLetterQueue());
  }

  async list(offset: number, limit: number): Promise<DeadLetterEntry[]> {
    const raw = await this.redisService.list.range(
      this.keys.deadLetterQueue(), offset, offset + limit - 1,
    );
    return raw.map((entry) => JSON.parse(entry) as DeadLetterEntry);
  }

  async retry(jobId: string): Promise<boolean> {
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);

    for (const entry of entries) {
      const parsed = JSON.parse(entry) as DeadLetterEntry;
      if (parsed.jobId === jobId) {
        await this.redisService.hash.set(this.keys.job(jobId), 'retryCount', '0');
        await this.redisService.hash.set(this.keys.job(jobId), 'status', 'PENDING');
        await this.redisService.list.append(this.keys.readyQueue(), jobId);
        await this.removeFromDLQ(entry);
        return true;
      }
    }
    return false;
  }

  async retryAll(): Promise<number> {
    const dlqKey = this.keys.deadLetterQueue();
    let count = 0;
    while (true) {
      const entry = await this.redisService.list.popHead(dlqKey);
      if (!entry) break;
      const parsed = JSON.parse(entry) as DeadLetterEntry;
      await this.redisService.hash.set(this.keys.job(parsed.jobId), 'retryCount', '0');
      await this.redisService.hash.set(this.keys.job(parsed.jobId), 'status', 'PENDING');
      await this.redisService.list.append(this.keys.readyQueue(), parsed.jobId);
      count++;
    }
    return count;
  }

  async purge(jobId: string): Promise<boolean> {
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);
    for (const entry of entries) {
      const parsed = JSON.parse(entry) as DeadLetterEntry;
      if (parsed.jobId === jobId) {
        await this.removeFromDLQ(entry);
        return true;
      }
    }
    return false;
  }

  async cleanup(olderThanMs?: number): Promise<number> {
    const retention = olderThanMs ?? this.config.reliableQueue.deadLetterRetentionMs;
    const cutoff = Date.now() - retention;
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);
    let removed = 0;
    for (const entry of entries) {
      const parsed = JSON.parse(entry) as DeadLetterEntry;
      if (parsed.failedAt < cutoff) {
        await this.removeFromDLQ(entry);
        removed++;
      }
    }
    return removed;
  }

  private async removeFromDLQ(entryJson: string): Promise<void> {
    const dlqKey = this.keys.deadLetterQueue();
    const allEntries = await this.redisService.list.range(dlqKey, 0, -1);
    const filtered = allEntries.filter((e) => e !== entryJson);
    await this.redisService.delete(dlqKey);
    for (const entry of filtered) {
      await this.redisService.list.append(dlqKey, entry);
    }
  }
}
```

### Idempotency Service

**`idempotency/IdempotencyService.ts`**

`RedisService.string.setNX()`를 사용하여 원자적 확인+마킹. `filterUnprocessed()`는 순차 호출 방식.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { BULK_ACTION_CONFIG, BulkActionConfig } from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  /**
   * 원자적으로 처리 여부를 확인하고 마킹한다.
   * @returns true이면 이미 처리됨 (중복), false이면 미처리 (첫 실행)
   */
  async isProcessed(key: string): Promise<boolean> {
    const ttlSec = Math.ceil(this.config.reliableQueue.idempotencyTtlMs / 1000);
    const redisKey = this.keys.idempotency(key);
    const acquired = await this.redisService.string.setNX(redisKey, '1', ttlSec);
    // setNX가 true(OK)이면 첫 실행 → isProcessed=false
    return !acquired;
  }

  async reset(key: string): Promise<void> {
    await this.redisService.delete(this.keys.idempotency(key));
  }

  async filterUnprocessed(keys: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const key of keys) {
      const processed = await this.isProcessed(key);
      if (!processed) {
        result.push(key);
      }
    }
    return result;
  }
}
```

### 모듈 등록 (최종)

**`BulkActionModule.ts`**

`RedisModule.register()` import + `reliableQueue` config merge + 5개 신규 서비스 등록.

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis/RedisModule';
// ... 기존 import 생략
import { ReliableQueueService } from './reliable-queue/ReliableQueueService';
import { InFlightQueueService } from './reliable-queue/InFlightQueueService';
import { OrphanRecoveryService } from './reliable-queue/OrphanRecoveryService';
import { DeadLetterService } from './reliable-queue/DeadLetterService';
import { IdempotencyService } from './idempotency/IdempotencyService';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: BulkActionRedisConfig } & {
      fairQueue?: Partial<FairQueueConfig>;
      backpressure?: Partial<BackpressureConfig>;
      congestion?: Partial<CongestionConfig>;
      workerPool?: Partial<WorkerPoolConfig>;
      aggregator?: Partial<AggregatorConfig>;
      watcher?: Partial<WatcherConfig>;
      reliableQueue?: Partial<ReliableQueueConfig>;
    },
  ): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      redis: config.redis,
      // ... 기존 config merge 생략
      reliableQueue: {
        ...DEFAULT_RELIABLE_QUEUE_CONFIG,
        ...config.reliableQueue,
      },
    };

    return {
      module: BulkActionModule,
      imports: [RedisModule.register({ /* redis config */ })],
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: mergedConfig },
        RedisKeyBuilder, LuaScriptLoader,
        // Step 1~5 기존 서비스 생략
        // Step 6: Reliable Queue
        ReliableQueueService,
        InFlightQueueService,
        OrphanRecoveryService,
        DeadLetterService,
        IdempotencyService,
        // ... WorkerPoolService 등
      ],
      exports: [
        // ... 기존 exports
        ReliableQueueService,
        InFlightQueueService,
        DeadLetterService,
        IdempotencyService,
        // OrphanRecoveryService는 내부 전용 (export하지 않음)
      ],
    };
  }
}
```

### LuaScriptLoader 등록

**`lua/LuaScriptLoader.ts`**에 4개 신규 스크립트 등록:

```typescript
await this.loadScript('reliableDequeue', 'reliable-dequeue.lua', 3);
await this.loadScript('reliableAck', 'reliable-ack.lua', 2);
await this.loadScript('recoverOrphans', 'recover-orphans.lua', 4);
await this.loadScript('extendDeadline', 'extend-deadline.lua', 2);
```

---

## Step 1~5와의 연동

### Worker 변경: blockingPop → reliable dequeue + poll+sleep

Step 4의 Worker에서 `ReadyQueueService` 의존성을 제거하고, **콜백 기반** reliable queue 패턴으로 교체한다. BLPOP 대신 non-blocking `dequeue()` + `setTimeout(pollIntervalMs)` 패턴을 사용한다.

**Worker.ts 생성자 시그니처:**

```typescript
constructor(
  readonly id: number,
  private readonly processorMap: Map<string, JobProcessor>,
  private readonly options: {
    jobTimeoutMs: number;
    pollIntervalMs: number;        // NEW (replaces timeoutSec)
    onJobComplete: (result: JobProcessorResponse) => Promise<void>;
    onJobFailed: (job: Job, error: Error) => Promise<void>;
    loadJobData: (jobId: string) => Promise<Record<string, string> | null>;
    reliableDequeue: (workerId: string) => Promise<DequeueResult | null>;  // NEW
    reliableAck: (jobId: string) => Promise<boolean>;                      // NEW
    reliableNack: (jobId: string) => Promise<void>;                        // NEW
    extendDeadline: (jobId: string) => Promise<boolean>;                   // NEW
  },
)
```

**tick() 핵심 흐름:**

```typescript
private async tick(): Promise<void> {
  const workerId = `worker-${this.id}`;
  const dequeueResult = await this.options.reliableDequeue(workerId);

  if (!dequeueResult) {
    await setTimeout(this.options.pollIntervalMs);  // poll+sleep 패턴
    return;
  }

  const { jobId } = dequeueResult;
  const job = await this.loadJob(jobId);

  if (!job) {
    await this.options.reliableAck(jobId);  // 데이터 없는 작업은 cleanup
    return;
  }

  this.currentJob = job;
  const startTime = Date.now();

  try {
    const processor = this.processorMap.get(job.processorType);
    if (!processor) throw new Error(`No processor for: ${job.processorType}`);

    // heartbeat 포함 실행
    const result = await this.executeWithHeartbeat(processor, job, jobId);
    result.durationMs = Date.now() - startTime;

    // 결과에 따라 ACK 또는 NACK
    if (result.success) {
      await this.options.reliableAck(jobId);
      await this.options.onJobComplete(result);
    } else if (result.error?.retryable) {
      await this.options.reliableNack(jobId);
      await this.options.onJobFailed(job, new Error(result.error.message));
    } else {
      await this.options.reliableAck(jobId);
      await this.options.onJobComplete(result);
    }
  } catch (error) {
    await this.options.reliableNack(jobId);
    await this.options.onJobFailed(job, error as Error);
  } finally {
    this.currentJob = null;
  }
}
```

**executeWithHeartbeat — 주기적 deadline 연장:**

```typescript
private async executeWithHeartbeat(
  processor: JobProcessor, job: Job, jobId: string,
): Promise<JobProcessorResponse> {
  const heartbeatIntervalMs = Math.floor(this.options.jobTimeoutMs * 0.6);
  const heartbeatHandle = setInterval(() => {
    void this.options.extendDeadline(jobId).catch((err) => {
      this.logger.warn(`Failed to extend deadline for ${jobId}: ${(err as Error).message}`);
    });
  }, heartbeatIntervalMs);

  try {
    return await this.executeWithTimeout(processor, job);
  } finally {
    clearInterval(heartbeatHandle);
  }
}
```

> **설계 결정: nack()은 In-flight 제거만 수행**
>
> `reliableNack()`은 `reliable-ack.lua`를 재사용하여 In-flight Queue에서만 제거한다.
> retry/DLQ 판정은 기존 `WorkerPoolService.handleJobFailed()`가 담당한다.
> 이로써 retry 정책이 한 곳(`WorkerPoolService`)에 집중된다.

### 전체 아키텍처 (Step 1~6 통합)

```
┌────────────────────────────────────────────────────────────────────────┐
│                     벌크액션 시스템 전체 아키텍처                         │
│                                                                        │
│  Client ── enqueue ──▶ ┌──────────────────┐                            │
│                        │  Fair Queue       │ Step 1                    │
│                        │  (우선순위 분배)    │                            │
│                        └────────┬─────────┘                            │
│                                 │                                      │
│  ┌──────────────────────────────┼──────────────────────────────────┐   │
│  │ Fetcher                      │                                  │   │
│  │                              ▼                                  │   │
│  │  ┌─────────────────┐   ┌─────────────┐                         │   │
│  │  │  Rate Limiter   │   │ Congestion  │  Step 2 + 3              │   │
│  │  │  (RPS 제한)      │   │ (동적 backoff)│                         │   │
│  │  └───┬─────────┬───┘   └──────┬──────┘                         │   │
│  │  allowed    denied            │                                 │   │
│  │      │         └──────────────┘                                 │   │
│  │      ▼                ▼                                         │   │
│  │ Ready Queue    Non-ready Queue                                  │   │
│  └──────┬───────────────┬──────────────────────────────────────────┘   │
│         │               │ Dispatcher (backoff 만료 작업 이동)          │
│         │◀──────────────┘                                              │
│         │                                                              │
│  ┌──────┼──────────────────────────────────────────────────────────┐   │
│  │      ▼  Step 6 ★                                                │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Reliable Dequeue     │  LPOP + ZADD (Lua 원자적)              │   │
│  │ │  Ready → In-flight    │  Non-blocking + poll+sleep 패턴       │   │
│  │ └──────────┬───────────┘                                        │   │
│  │            │                                                    │   │
│  │            ▼                                                    │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Worker ×N            │  Step 4                                │   │
│  │ │  process() + heartbeat│  콜백 기반 (서비스 미주입)              │   │
│  │ └───┬────────────┬─────┘                                        │   │
│  │   성공          실패                                              │   │
│  │     │             │                                              │   │
│  │     ▼             ▼                                              │   │
│  │   ACK           NACK                                            │   │
│  │   (In-flight    (In-flight 제거만 수행)                          │   │
│  │    에서 제거)    → handleJobFailed가 retry/DLQ 판정              │   │
│  │     │                                                           │   │
│  │     ▼                                                           │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Aggregator           │  Step 5                                │   │
│  │ │  recordJobResult()    │                                        │   │
│  │ └──────────────────────┘                                        │   │
│  │                                                                 │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Orphan Recovery      │  Step 6 ★                              │   │
│  │ │  주기적 스캔            │                                        │   │
│  │ │  timeout → Ready Queue │                                       │   │
│  │ │  maxRetry → DLQ       │                                        │   │
│  │ │    + Aggregator 집계   │  handleDeadLetteredOrphans()           │   │
│  │ │    + FairQueue ACK    │                                        │   │
│  │ └──────────────────────┘                                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Watcher (Step 5)                                                 │   │
│  │  상태 전이 감시: CREATED → DISPATCHED → RUNNING → AGGREGATING     │   │
│  │  → reduce() → COMPLETED                                         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  Client ◀── getResult() ── 최종 집계 결과                               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 시퀀스 다이어그램: Orphan 복구 시나리오

```
Worker A        ReliableQueue     In-flight       Recovery        Worker B
   │                 │                │               │               │
   │  dequeue()      │                │               │               │
   │────────────────▶│  LPOP+ZADD    │               │               │
   │                 │───────────────▶│               │               │
   │  job-001        │                │               │               │
   │◀────────────────│                │ deadline=t+40s│               │
   │                 │                │               │               │
   │  process()...   │                │               │               │
   │  ┌──────┐       │                │               │               │
   │  │크래시│       │                │               │               │
   │  └──────┘       │                │               │               │
   ✗                 │                │               │               │
                     │                │  t+40s 도달   │               │
                     │                │◀──────────────│               │
                     │                │  ZRANGEBYSCORE │               │
                     │                │  score <= now  │               │
                     │                │───────────────▶│               │
                     │                │  [job-001]     │               │
                     │                │               │               │
                     │  RPUSH         │  ZREM         │               │
                     │◀───────────────│◀──────────────│               │
                     │  ready-queue   │               │               │
                     │                │               │               │
                     │                │               │  dequeue()    │
                     │◀──────────────────────────────────────────────│
                     │  LPOP+ZADD    │               │               │
                     │───────────────▶│               │               │
                     │  job-001       │               │               │
                     │───────────────────────────────────────────────▶│
                     │                │               │               │
                     │                │               │  process()    │
                     │                │               │  → ACK ✓     │
```

---

## 테스트 전략

> 모든 테스트는 **실제 Redis** 사용, `given/when/then` 주석 패턴, `beforeEach`에서 `redisService.flushDatabase()`, `--runInBand` 필수.
> 테스트 설정은 `createTestBulkActionConfig()` 팩토리 함수 사용.

### 테스트 파일 목록

| 파일 | 테스트 수 | 핵심 검증 |
|------|----------|----------|
| `ReliableQueueService.spec.ts` | 9 | dequeue→In-flight 이동, ack/nack, extendDeadline, empty queue null |
| `OrphanRecoveryService.spec.ts` | 4 | timeout 복구, maxRetry→DLQ+집계, 미만료 작업 무시, 누적 통계 |
| `InFlightQueueService.spec.ts` | 7 | size, isInFlight, getEntry, getAllEntries, orphanedCount |
| `DeadLetterService.spec.ts` | 7 | size, list 페이지네이션, retry/retryAll, purge, cleanup |
| `IdempotencyService.spec.ts` | 6 | isProcessed, reset, filterUnprocessed, 중복 감지 |
| `Worker.spec.ts` | 12 | reliableDequeue, ack/nack 호출 확인, heartbeat, poll+sleep |

### 핵심 테스트 패턴

```typescript
// 테스트 설정 — createTestBulkActionConfig 사용
const config = createTestBulkActionConfig({
  reliableQueue: { ackTimeoutMs: 5000 },
});

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
      RedisKeyBuilder, LuaScriptLoader,
      ReliableQueueService,
    ],
  }).compile();
  await module.init();
});

// Job 시드 헬퍼 — keys.job(), keys.readyQueue() 사용
async function seedJob(jobId: string, groupId: string): Promise<void> {
  await redisService.hash.set(keys.job(jobId), 'id', jobId);
  await redisService.hash.set(keys.job(jobId), 'groupId', groupId);
  await redisService.hash.set(keys.job(jobId), 'retryCount', '0');
  await redisService.hash.set(keys.job(jobId), 'processorType', 'TEST');
  await redisService.hash.set(keys.job(jobId), 'payload', '{}');
  await redisService.hash.set(keys.job(jobId), 'status', 'PENDING');
  await redisService.hash.set(keys.job(jobId), 'createdAt', '0');
  await redisService.list.append(keys.readyQueue(), jobId);
}
```

### OrphanRecoveryService 핵심 테스트: DLQ 집계

```typescript
it('maxRetry 초과 시 DLQ로 이동하고 집계를 수행한다', async () => {
  // given — retryCount가 이미 maxRetryCount(2)에 도달
  await seedJob('job-002', 'group-B', 2);
  await seedGroupMeta('group-B', 1);
  await reliableQueue.dequeue('worker-0');
  await new Promise((resolve) => setTimeout(resolve, 200));

  // when
  const result = await service.runOnce();

  // then
  expect(result.recovered).toBe(0);
  expect(result.deadLettered).toBe(1);

  // DLQ에 존재해야 함
  const dlqSize = await redisService.list.length(keys.deadLetterQueue());
  expect(dlqSize).toBe(1);

  // ⚠️ Job 상태: recover-orphans.lua가 FAILED로 설정 후
  // fairQueue.ack이 COMPLETED로 변경 (ack.lua가 항상 COMPLETED로 설정)
  const status = await redisService.hash.get(keys.job('job-002'), 'status');
  expect(status).toBe('COMPLETED');
});
```

---

## 운영 고려사항

### 모니터링 지표

```
# In-flight 상태
bulk_action_in_flight_size                             # 현재 In-flight 작업 수
bulk_action_in_flight_orphaned_size                    # 타임아웃된 작업 수

# Reliable Queue 성능
bulk_action_reliable_dequeue_total                     # 총 dequeue 수
bulk_action_reliable_ack_total                         # 정상 ACK 수
bulk_action_reliable_late_ack_total                    # Late ACK 수 (이미 orphan 복구됨)
bulk_action_reliable_nack_total                        # NACK 수
bulk_action_reliable_extend_deadline_total             # Deadline 연장 수

# Orphan Recovery
bulk_action_orphan_recovery_cycles_total               # 복구 사이클 수
bulk_action_orphan_recovered_total                     # 복구된 작업 수
bulk_action_orphan_dead_lettered_total                 # Dead Letter로 이동된 수

# Dead Letter Queue
bulk_action_dead_letter_size                           # DLQ 크기
bulk_action_dead_letter_retry_total                    # 수동 재시도 수

# 멱등성
bulk_action_idempotency_hit_total                      # 중복 감지 (스킵됨)
bulk_action_idempotency_miss_total                     # 신규 처리
```

### 알림 조건

| 조건 | 심각도 | 대응 |
|------|-------|------|
| `in_flight_orphaned_size > 0` 지속 | Warning | Worker 상태 확인, ACK timeout 적절한지 검토 |
| `late_ack_total` 급증 | Warning | ACK timeout이 너무 짧거나 Worker가 느림 |
| `dead_letter_size` 증가 | Critical | 실패 원인 분석, 외부 API 상태 확인 |
| `dead_letter_size > 1000` | Critical | 시스템적 문제. 원인 해결 후 retryAll 고려 |
| `orphan_recovered / dequeue` > 5% | Warning | 인스턴스 안정성 문제, 메모리/네트워크 점검 |

### 설정 튜닝 가이드

| 설정 | 기본값 | 조정 기준 |
|------|-------|----------|
| `ackTimeoutMs` | 40,000 | 작업 최대 실행시간 × 1.5. 너무 짧으면 중복, 너무 길면 복구 지연 |
| `orphanRecoveryIntervalMs` | 5,000 | 복구 지연 허용치. 낮으면 빠르지만 Redis 부하 |
| `orphanRecoveryBatchSize` | 100 | 1회 복구 최대 수. 대량 orphan 발생 시 증가 |
| `maxRetryCount` | 3 | 일시적 오류 비율 기반. 높으면 DLQ 감소, 무한 재시도 위험 |
| `deadLetterRetentionMs` | 30일 | 분석 및 재처리 기간. Redis 메모리 고려 |
| `idempotencyTtlMs` | 24시간 | 작업 중복 가능 기간. 짧으면 메모리 절약, 길면 안전 |
| `workerPollIntervalMs` | 200 | Empty queue poll 간격. 낮으면 반응 빠르지만 CPU 사용 증가 |

### Redis Stream 대안 검토

BLPOP 기반 Reliable Queue의 원자성 한계를 극복하려면 **Redis Stream**을 검토한다.

| 항목 | 현재 (List + Sorted Set) | Redis Stream (XREADGROUP) |
|------|------------------------|--------------------------|
| 원자적 dequeue | Lua 스크립트 필요 | 네이티브 지원 (Consumer Group) |
| ACK | 수동 관리 (ZADD/ZREM) | XACK 내장 |
| Orphan 복구 | 수동 스캔 + 복구 | XPENDING + XCLAIM 내장 |
| 메시지 순서 | 보장 안 됨 (LPOP) | 보장됨 (Stream ID 순서) |
| 복잡도 | 중간 (Lua 스크립트) | 낮음 (네이티브 API) |
| Redis 버전 | 2.6+ | 5.0+ |

Redis 5.0 이상을 사용할 수 있다면 Stream 기반으로 마이그레이션하는 것이 장기적으로 유리하다.

### 장애 시나리오 대응

| 시나리오 | 증상 | 대응 |
|---------|------|------|
| 대규모 인스턴스 크래시 | In-flight에 대량 orphan | orphanRecoveryBatchSize 임시 증가 |
| Redis 재시작 | In-flight Queue 유실 (RDB/AOF 미설정 시) | AOF 필수 설정. 유실 시 Worker가 재처리 |
| Orphan Recovery 과부하 | 복구가 다음 사이클보다 오래 걸림 | batchSize 증가, interval 조정 |
| 멱등성 키 TTL 이슈 | TTL 만료 후 중복 실행 | TTL을 벌크액션 최대 실행시간 이상으로 설정 |
| DLQ 폭발 | 외부 API 장기 장애 | 장애 해소 후 retryAll. 알림 임계값 조정 |

### WorkerPoolService 변경

**`worker-pool/WorkerPoolService.ts`**

- `ReadyQueueService` 의존성 제거, `ReliableQueueService` 주입 추가
- `createWorkers()`: 콜백 기반으로 reliable queue 전달
- `handleJobComplete()`: Worker가 ACK 후 호출 → **ACK은 Worker에서 수행**

```typescript
constructor(
  // ... 기존 주입
  private readonly reliableQueue: ReliableQueueService,  // NEW
) {}

private createWorkers(): void {
  const { workerCount, jobTimeoutMs } = this.config.workerPool;
  const { workerPollIntervalMs } = this.config.reliableQueue;

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(i, this.processorMap, {
      jobTimeoutMs,
      pollIntervalMs: workerPollIntervalMs,
      onJobComplete: async (result) => this.handleJobComplete(result),
      onJobFailed: async (job, error) => this.handleJobFailed(job, error),
      loadJobData: async (jobId) =>
        this.redisService.hash.getAll(this.keys.job(jobId)),
      reliableDequeue: async (workerId) =>
        this.reliableQueue.dequeue(workerId),
      reliableAck: async (jobId) => this.reliableQueue.ack(jobId),
      reliableNack: async (jobId) => this.reliableQueue.nack(jobId),
      extendDeadline: async (jobId) =>
        this.reliableQueue.extendDeadline(jobId),
    });
    this.workers.push(worker);
  }
}
```

> **주요 설계 결정**: Worker가 ACK/NACK을 직접 호출한 후 `onJobComplete`/`onJobFailed`를 호출한다.
> `handleJobComplete()`에서는 ACK을 수행하지 않는다 — ACK은 Worker.tick()에서 이미 완료됨.

#### Step 5 Aggregator 연동: OrphanRecovery → handleDeadLetteredOrphans

Orphan Recovery에서 Dead Letter로 이동된 작업도 Step 5 집계에 반영한다.
`recover-orphans.lua`가 반환하는 `{jobId, groupId}` 쌍을 사용하여 Node.js에서 처리한다.

```typescript
// OrphanRecoveryService.handleDeadLetteredOrphans()
private async handleDeadLetteredOrphans(pairs: string[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += 2) {
    const jobId = pairs[i];
    const groupId = pairs[i + 1];

    // 1. 실패 집계
    await this.aggregatorService.recordJobResult({
      jobId, groupId, success: false, durationMs: 0,
      processorType: '',
      error: { message: 'orphan: max retries exceeded', retryable: false },
    });

    // 2. Fair Queue ACK (그룹 완료 여부 확인)
    // ⚠️ ack.lua가 job status를 COMPLETED로 덮어씌움
    const isGroupCompleted = await this.fairQueue.ack(jobId, groupId);

    // 3. 그룹 완료 시 집계 최종화
    if (isGroupCompleted) {
      await this.aggregatorService.finalizeGroup(groupId);
    }
  }
}
```

### 완성된 시스템 요약

```
Step 1. Fair Queue           "어떤 순서로" ─ 고객사별 공정한 우선순위
Step 2. Rate Limiting        "얼마나 빨리" ─ RPS 제한으로 과부하 방지
Step 3. Congestion Control   "언제 재시도" ─ 동적 backoff로 공회전 방지
Step 4. Worker Pool          "누가 실행"   ─ Fetcher/Worker/Dispatcher 병렬 실행
Step 5. Aggregator & Watcher "결과를 모아" ─ MapReduce 집계 + 상태 관리
Step 6. Reliable Queue       "안전하게"    ─ At-least-once + 멱등성 보장
```


### 문서 갱신 히스토리

#### 1. 2026-02-04
```
 #: 1                                                                                                                            
  이슈: blockingDequeue() return 뒤 도달 불가 주석                                                                                
  수정 내용: 원자성 경고를 JSDoc으로 이동, 대안(Redis Stream/non-blocking Lua) 명시. retryCount/groupId 저장 추가                 
  ────────────────────────────────────────                                                                                        
  #: 2                                                                                                                            
  이슈: recover_orphans.lua job: 키 하드코딩                                                                                      
  수정 내용: ARGV[4]로 Job 키 접두사를 전달. groupId도 Dead Letter entry에 포함. Dead Letter jobId 목록 반환 추가                 
  ────────────────────────────────────────                                                                                        
  #: 3                                                                                                                            
  이슈: reliable_dequeue.lua/ack_job.lua Cluster 해시 슬롯 위반                                                                   
  수정 내용: 해시 태그({bulk-action}) 사용 가이드 추가. retryCount/groupId를 ARGV로 전달하여 Lua 내부 Job Hash 접근 제거          
  ────────────────────────────────────────                                                                                        
  #: 4                                                                                                                            
  이슈: nack() Non-ready/Dead Letter 이동 미구현                                                                                  
  수정 내용: retryCount 갱신 + CongestionControl addToNonReady() 호출 또는 Ready Queue 직접 복귀. Dead Letter 이동 로직 구현      
  ────────────────────────────────────────                                                                                        
  #: 5                                                                                                                            
  이슈: extendDeadline() 비원자적 Race condition                                                                                  
  수정 내용: Lua 스크립트로 ZSCORE+ZADD+HSET을 원자적 수행. OrphanRecovery와의 Race condition 방지                                
  ────────────────────────────────────────                                                                                        
  #: 6                                                                                                                            
  이슈: DeadLetterService O(N²) 성능                                                                                              
  수정 내용: LRANGE(0,-1) → 배치 탐색(BATCH_SIZE=100). cleanup() offset 보정 로직 추가. 보조 인덱스 가이드                        
  ────────────────────────────────────────                                                                                        
  #: 7                                                                                                                            
  이슈: recover_orphans.lua retryCount 항상 0                                                                                     
  수정 내용: reliable_dequeue.lua에 retryCount/groupId 저장, blockingDequeue()/dequeue()에서 Job Hash 조회 후 전달                
  ────────────────────────────────────────                                                                                        
  #: 8
  이슈: Step 4/5 연동 인터페이스 부재
  수정 내용: Step 4 교체 5개 지점 테이블, handleJobComplete() 최종 형태, OrphanRecovery→Aggregator 연동, firstJobStartedAt HSETNX
```

#### 2. 2026-03-06 — 실제 구현 반영 갱신
```
  설계 문서의 구현 코드 섹션을 실제 코드와 일치시킴. 주요 변경:

  1. Redis 접근: raw ioredis → RedisService 래퍼
  2. 키 관리: 하드코딩 → RedisKeyBuilder
  3. 파일명: kebab-case → PascalCase (프로젝트 컨벤션)
  4. Lua 스크립트명: reliable_dequeue/ack_job → reliableDequeue/reliableAck/extendDeadline
  5. blockingDequeue 제거 → non-blocking dequeue + poll+sleep 패턴
  6. nack(): retry/DLQ 로직 제거 → In-flight 제거만 (reliable-ack.lua 재사용)
     retry/DLQ 판정은 기존 WorkerPoolService.handleJobFailed()가 담당
  7. Worker: 서비스 주입 → 콜백 기반 (plain class 유지)
  8. OrphanRecovery: @Optional() aggregator → AggregatorService + FairQueueService 직접 주입
     handleDeadLetteredOrphans()로 {jobId, groupId} 쌍 처리
  9. Config: workerPollIntervalMs 추가
  10. 테스트: createTestBulkActionConfig() 팩토리, RedisService/RedisKeyBuilder 사용
```
