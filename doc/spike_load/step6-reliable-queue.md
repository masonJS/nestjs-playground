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

### Lua 스크립트: reliable_dequeue.lua

Ready Queue에서 pop하고 In-flight Queue에 등록하는 원자적 연산이다.

> ⚠️ **Redis Cluster 해시 슬롯 주의:**
> Lua 내부에서 `KEYS[3] .. ':' .. jobId` 로 동적 키를 생성하면,
> 이 키가 KEYS 배열에 포함되지 않아 Redis Cluster에서 해시 슬롯을 사전 결정할 수 없다.
>
> **Standalone Redis** 환경에서는 문제 없으나, **Redis Cluster** 환경에서는:
> - 모든 KEYS가 같은 해시 슬롯에 있어야 한다 → `{bulk-action}` 해시 태그 사용
> - 동적 생성 키도 같은 해시 태그를 포함해야 한다
>
> Cluster 환경 대응:
> ```
> KEYS[1] = {bulk-action}:ready-queue
> KEYS[2] = {bulk-action}:in-flight-queue
> KEYS[3] = {bulk-action}:in-flight    ← 접두사
> 동적 키 = {bulk-action}:in-flight:job-001  ← 같은 해시 태그
> ```

```lua
-- KEYS[1]: ready queue (List)
-- KEYS[2]: in-flight queue (Sorted Set)
-- KEYS[3]: in-flight metadata prefix
-- ARGV[1]: ACK timeout (ms)
-- ARGV[2]: worker ID
-- ARGV[3]: instance ID
-- ARGV[4]: Job 키 접두사 (keyPrefix 대응, 예: 'bulk-action:job:')
-- ARGV[5]: retryCount (Node.js에서 Job Hash 조회 후 전달)
-- ARGV[6]: groupId (Node.js에서 Job Hash 조회 후 전달)

-- 1. Ready Queue에서 pop
local jobId = redis.call('LPOP', KEYS[1])
if not jobId then
  return nil
end

-- 2. ACK deadline 계산
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local deadline = nowMs + tonumber(ARGV[1])

-- 3. In-flight Queue에 등록
redis.call('ZADD', KEYS[2], deadline, jobId)

-- 4. In-flight 메타데이터 저장
-- ⚠️ retryCount, groupId를 포함해야 recover_orphans.lua에서
-- Dead Letter 판정과 Step 5 집계 연동이 가능하다 (Issue #7).
local metaKey = KEYS[3] .. ':' .. jobId
redis.call('HSET', metaKey,
  'jobId', jobId,
  'workerId', ARGV[2],
  'instanceId', ARGV[3],
  'retryCount', ARGV[5] or '0',
  'groupId', ARGV[6] or '',
  'startedAt', tostring(nowMs),
  'deadline', tostring(deadline)
)
-- 메타데이터 TTL = timeout + 60초 여유
local ttlSec = math.ceil(tonumber(ARGV[1]) / 1000) + 60
redis.call('EXPIRE', metaKey, ttlSec)

return {jobId, tostring(deadline)}
```

### Lua 스크립트: ack_job.lua

작업 완료 확인(ACK)이다.

> ⚠️ 동일한 Redis Cluster 해시 슬롯 주의사항이 적용된다.
> `KEYS[2] .. ':' .. ARGV[1]` 동적 키는 같은 해시 태그(`{bulk-action}`)를 포함해야 한다.

```lua
-- KEYS[1]: in-flight queue (Sorted Set)
-- KEYS[2]: in-flight metadata prefix
-- ARGV[1]: jobId

-- 1. In-flight Queue에서 제거
local removed = redis.call('ZREM', KEYS[1], ARGV[1])

-- 2. 메타데이터 삭제
local metaKey = KEYS[2] .. ':' .. ARGV[1]
redis.call('DEL', metaKey)

return removed  -- 1이면 정상 ACK, 0이면 이미 제거됨 (timeout으로 복구된 경우)
```

### Lua 스크립트: recover_orphans.lua

타임아웃된 작업을 복구한다.

> ⚠️ **ioredis keyPrefix 주의 (Step 3 이슈 #8과 동일 패턴):**
> Lua 내부에서 `'job:' .. jobId` 로 키를 구성하면, ioredis의 `keyPrefix`가 적용되지 않는다.
> - Node.js: `redis.hget('job:001', ...)` → 실제 키 `bulk-action:job:001` (keyPrefix 적용)
> - Lua 내부: `redis.call('HGET', 'job:' .. '001', ...)` → 실제 키 `job:001` (keyPrefix 미적용)
>
> **해결:** Job 키 접두사를 ARGV로 전달한다. 아래 수정된 스크립트에서 `ARGV[4]`로 전달.

```lua
-- KEYS[1]: in-flight queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- KEYS[3]: dead letter queue (List)
-- KEYS[4]: in-flight metadata prefix
-- ARGV[1]: 현재 시각 (epoch ms)
-- ARGV[2]: 최대 복구 수 (batch size)
-- ARGV[3]: 최대 재시도 횟수
-- ARGV[4]: Job 키 접두사 (예: 'bulk-action:job:' 또는 'job:')
--          Node.js에서 `${redis.options.keyPrefix ?? ''}job:` 형태로 전달한다.

local maxRetry = tonumber(ARGV[3])
local jobKeyPrefix = ARGV[4]

-- 1. 타임아웃된 작업 조회
local orphans = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #orphans == 0 then
  return {0, 0}  -- {recovered, deadLettered}
end

local recovered = 0
local deadLettered = 0
local deadLetteredJobIds = {}

for _, jobId in ipairs(orphans) do
  -- 2. In-flight Queue에서 제거
  redis.call('ZREM', KEYS[1], jobId)

  -- 3. 메타데이터에서 retryCount 확인
  local metaKey = KEYS[4] .. ':' .. jobId
  local metaRetryCount = tonumber(redis.call('HGET', metaKey, 'retryCount') or '0')

  -- In-flight 메타에 retryCount가 없으면 Job Hash에서 조회 (하위 호환)
  local jobKey = jobKeyPrefix .. jobId
  if metaRetryCount == 0 then
    metaRetryCount = tonumber(redis.call('HGET', jobKey, 'retryCount') or '0')
  end

  if metaRetryCount < maxRetry then
    -- 4a. 재시도 가능 → Ready Queue로 복구
    redis.call('RPUSH', KEYS[2], jobId)

    -- Job 데이터의 retryCount 증가
    redis.call('HINCRBY', jobKey, 'retryCount', 1)
    redis.call('HSET', jobKey, 'status', 'PENDING')

    recovered = recovered + 1
  else
    -- 4b. 최대 재시도 초과 → Dead Letter Queue
    local now = ARGV[1]
    local groupId = redis.call('HGET', metaKey, 'groupId') or ''
    local entry = cjson.encode({
      jobId = jobId,
      groupId = groupId,
      retryCount = metaRetryCount,
      failedAt = tonumber(now),
    })
    redis.call('RPUSH', KEYS[3], entry)

    redis.call('HSET', jobKey, 'status', 'FAILED')

    deadLettered = deadLettered + 1
    table.insert(deadLetteredJobIds, jobId)
  end

  -- 5. 메타데이터 삭제
  redis.call('DEL', metaKey)
end

-- Dead Letter로 이동된 jobId 목록도 반환 (Step 5 Aggregator 연동용)
return {recovered, deadLettered, unpack(deadLetteredJobIds)}
```

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/src/
├── reliable-queue/
│   ├── reliable-queue.service.ts             # 신뢰성 있는 큐 서비스
│   ├── reliable-queue.service.spec.ts        # 통합 테스트
│   ├── in-flight-queue.service.ts            # In-flight 작업 추적
│   ├── in-flight-queue.service.spec.ts       # In-flight 테스트
│   ├── orphan-recovery.service.ts            # Orphaned Job 복구
│   ├── orphan-recovery.service.spec.ts       # 복구 테스트
│   ├── dead-letter.service.ts                # Dead Letter 관리
│   └── reliable-queue.constants.ts           # 상수 정의
├── idempotency/
│   ├── idempotency.service.ts                # 멱등성 헬퍼
│   └── idempotency.service.spec.ts           # 멱등성 테스트
├── config/
│   └── bulk-action.config.ts                 # reliableQueue 설정 추가
└── lua/
    ├── reliable_dequeue.lua                  # 원자적 pop + in-flight 등록
    ├── ack_job.lua                           # ACK 처리
    └── recover_orphans.lua                   # Orphan 복구
```

### 설정 확장

**`config/bulk-action.config.ts`** (최종)

```typescript
export interface BulkActionConfig {
  redis: { /* ... */ };
  fairQueue: { /* ... */ };
  backpressure: { /* ... */ };
  congestion: { /* ... */ };
  workerPool: { /* ... */ };
  aggregator: { /* ... */ };
  watcher: { /* ... */ };
  reliableQueue: {
    ackTimeoutMs: number;              // ACK 타임아웃 (default: 40000)
    orphanRecoveryIntervalMs: number;  // 복구 스캔 주기 (default: 5000)
    orphanRecoveryBatchSize: number;   // 1회 최대 복구 수 (default: 100)
    maxRetryCount: number;             // 최대 재시도 (default: 3, workerPool과 공유 가능)
    deadLetterRetentionMs: number;     // DLQ 보관 기간 (default: 30일)
    idempotencyTtlMs: number;          // 멱등성 키 TTL (default: 86400000 = 24시간)
  };
}

export const DEFAULT_BULK_ACTION_CONFIG: BulkActionConfig = {
  // ... 기존 설정 생략
  reliableQueue: {
    ackTimeoutMs: 40000,
    orphanRecoveryIntervalMs: 5000,
    orphanRecoveryBatchSize: 100,
    maxRetryCount: 3,
    deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1000,
    idempotencyTtlMs: 86400000,
  },
};
```

---

## 구현 코드

### In-flight Queue Service

**`reliable-queue/in-flight-queue.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

export interface InFlightEntry {
  jobId: string;
  groupId: string;
  workerId: string;
  instanceId: string;
  startedAt: number;
  deadline: number;
  retryCount: number;
}

@Injectable()
export class InFlightQueueService {
  private readonly logger = new Logger(InFlightQueueService.name);
  private readonly queueKey = 'in-flight-queue';
  private readonly metaPrefix = 'in-flight';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * In-flight Queue의 현재 크기를 반환한다.
   */
  async size(): Promise<number> {
    return this.redis.zcard(this.queueKey);
  }

  /**
   * 특정 작업이 In-flight 상태인지 확인한다.
   */
  async isInFlight(jobId: string): Promise<boolean> {
    const score = await this.redis.zscore(this.queueKey, jobId);
    return score !== null;
  }

  /**
   * 타임아웃된 (orphaned) 작업 수를 반환한다.
   */
  async orphanedCount(): Promise<number> {
    return this.redis.zcount(this.queueKey, '-inf', Date.now().toString());
  }

  /**
   * 특정 작업의 In-flight 메타데이터를 조회한다.
   */
  async getEntry(jobId: string): Promise<InFlightEntry | null> {
    const metaKey = `${this.metaPrefix}:${jobId}`;
    const data = await this.redis.hgetall(metaKey);

    if (!data.jobId) return null;

    return {
      jobId: data.jobId,
      groupId: data.groupId ?? '',
      workerId: data.workerId ?? '',
      instanceId: data.instanceId ?? '',
      startedAt: parseInt(data.startedAt ?? '0', 10),
      deadline: parseInt(data.deadline ?? '0', 10),
      retryCount: parseInt(data.retryCount ?? '0', 10),
    };
  }

  /**
   * 전체 In-flight 작업 목록을 반환한다. (모니터링용)
   */
  async getAllEntries(): Promise<Array<{ jobId: string; deadline: number }>> {
    const entries = await this.redis.zrange(this.queueKey, 0, -1, 'WITHSCORES');
    const result: Array<{ jobId: string; deadline: number }> = [];

    for (let i = 0; i < entries.length; i += 2) {
      result.push({
        jobId: entries[i],
        deadline: parseInt(entries[i + 1], 10),
      });
    }

    return result;
  }

  /**
   * 특정 Worker/Instance의 In-flight 작업을 조회한다.
   */
  async getByInstance(instanceId: string): Promise<string[]> {
    // SCAN으로 메타데이터 검색 (성능 주의)
    const jobs: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', `${this.metaPrefix}:*`, 'COUNT', 100,
      );
      cursor = nextCursor;

      for (const key of keys) {
        const instId = await this.redis.hget(key, 'instanceId');
        if (instId === instanceId) {
          const jobId = await this.redis.hget(key, 'jobId');
          if (jobId) jobs.push(jobId);
        }
      }
    } while (cursor !== '0');

    return jobs;
  }
}
```

### Reliable Queue Service

**`reliable-queue/reliable-queue.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

export interface DequeueResult {
  jobId: string;
  deadline: number;
}

@Injectable()
export class ReliableQueueService {
  private readonly logger = new Logger(ReliableQueueService.name);
  private readonly instanceId = randomUUID();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * Ready Queue에서 작업을 꺼내고 In-flight Queue에 등록한다.
   *
   * Lua 스크립트로 두 연산을 원자적으로 수행한다.
   * 이 메서드가 Step 4 Worker의 readyQueue.pop()을 대체한다.
   */
  /**
   * ⚠️ retryCount/groupId를 Lua에 전달:
   * recover_orphans.lua에서 In-flight 메타의 retryCount로 Dead Letter 판정을 하므로,
   * dequeue 시점에 Job Hash에서 retryCount와 groupId를 조회하여 Lua에 전달해야 한다.
   *
   * 이 조회는 Lua 실행 전에 수행한다 (Lua 내에서 job: 키에 접근하면
   * keyPrefix/Cluster 해시 슬롯 문제가 발생하므로).
   */
  async dequeue(workerId: string): Promise<DequeueResult | null> {
    try {
      // Ready Queue에 작업이 있는지 미리 확인 (불필요한 Job Hash 조회 방지)
      const queueLen = await this.redis.llen('ready-queue');
      if (queueLen === 0) return null;

      // Ready Queue의 첫 항목을 peek하여 retryCount/groupId를 미리 조회
      // (LPOP은 Lua 내에서 수행하므로, 여기서는 LINDEX로 peek만 한다)
      const peekJobId = await this.redis.lindex('ready-queue', 0);
      let retryCount = '0';
      let groupId = '';
      if (peekJobId) {
        const [rc, gid] = await Promise.all([
          this.redis.hget(`job:${peekJobId}`, 'retryCount'),
          this.redis.hget(`job:${peekJobId}`, 'groupId'),
        ]);
        retryCount = rc ?? '0';
        groupId = gid ?? '';
      }

      const jobKeyPrefix = (this.redis.options?.keyPrefix ?? '') + 'job:';

      const result = await (this.redis as any).reliable_dequeue(
        'ready-queue',
        'in-flight-queue',
        'in-flight',
        this.config.reliableQueue.ackTimeoutMs.toString(),
        workerId,
        this.instanceId,
        jobKeyPrefix,
        retryCount,
        groupId,
      );

      if (!result) return null;

      const jobId = result[0];
      const deadline = parseInt(result[1], 10);

      this.logger.debug(
        `Dequeued job ${jobId} (worker=${workerId}, deadline=${new Date(deadline).toISOString()})`,
      );

      return { jobId, deadline };
    } catch (error) {
      this.logger.error(`Reliable dequeue failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 블로킹 dequeue.
   *
   * Ready Queue가 비어있으면 timeout까지 대기한다.
   * BLPOP은 Lua 스크립트 내에서 사용할 수 없으므로,
   * BLPOP으로 대기 후 pop된 아이템을 In-flight에 등록한다.
   */
  /**
   * ⚠️ 원자성 경고: BLPOP → ZADD 사이 크래시 시 작업 유실 가능
   *
   * BLPOP은 Lua 스크립트 내에서 사용할 수 없으므로(blocking 명령 제한),
   * BLPOP과 ZADD를 원자적으로 묶을 수 없다.
   *
   * 유실 시나리오:
   *   1. BLPOP으로 job-001을 Ready Queue에서 꺼냄
   *   2. (이 시점에서 프로세스 크래시)
   *   3. In-flight Queue에 등록되지 않음 → Orphan Recovery 대상에서도 제외
   *   4. job-001 영구 유실
   *
   * 대안:
   *   - Redis Stream의 XREADGROUP + Consumer Group 사용 (운영 고려사항 참조)
   *   - non-blocking dequeue()를 사용하면 Lua 스크립트로 원자적 처리 가능
   *     (LPOP + ZADD를 하나의 Lua에서 수행. 대기는 Fetcher 루프에서 sleep으로 대체)
   */
  async blockingDequeue(workerId: string, timeoutSec: number): Promise<DequeueResult | null> {
    // 1. BLPOP으로 대기
    const result = await this.redis.blpop('ready-queue', timeoutSec);
    if (!result) return null;

    const jobId = result[1];

    // 2. In-flight Queue에 등록
    const now = Date.now();
    const deadline = now + this.config.reliableQueue.ackTimeoutMs;

    await this.redis.zadd('in-flight-queue', deadline.toString(), jobId);

    // 3. 메타데이터 저장 (retryCount 포함 — Issue #7 참조)
    const metaKey = `in-flight:${jobId}`;
    const ttlSec = Math.ceil(this.config.reliableQueue.ackTimeoutMs / 1000) + 60;

    // Job Hash에서 retryCount와 groupId를 조회하여 메타데이터에 포함시킨다.
    // recover_orphans.lua에서 retryCount 기반 Dead Letter 판정에 사용된다.
    const [retryCount, groupId] = await Promise.all([
      this.redis.hget(`job:${jobId}`, 'retryCount'),
      this.redis.hget(`job:${jobId}`, 'groupId'),
    ]);

    await this.redis.hmset(metaKey, {
      jobId,
      workerId,
      instanceId: this.instanceId,
      groupId: groupId ?? '',
      retryCount: retryCount ?? '0',
      startedAt: now.toString(),
      deadline: deadline.toString(),
    });
    await this.redis.expire(metaKey, ttlSec);

    this.logger.debug(
      `Blocking dequeued job ${jobId} (worker=${workerId})`,
    );

    return { jobId, deadline };
  }

  /**
   * 작업 완료 확인(ACK).
   *
   * @returns true면 정상 ACK, false면 이미 만료됨 (orphan 복구로 인해)
   */
  async ack(jobId: string): Promise<boolean> {
    try {
      const removed = await (this.redis as any).ack_job(
        'in-flight-queue',
        'in-flight',
        jobId,
      );

      const isNormalAck = removed === 1;

      if (!isNormalAck) {
        this.logger.warn(
          `Late ACK for job ${jobId} (already recovered as orphan)`,
        );
      }

      return isNormalAck;
    } catch (error) {
      this.logger.error(`ACK failed for job ${jobId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 작업 실패 보고(NACK).
   *
   * In-flight에서 제거하고 Non-ready Queue(재시도) 또는
   * Dead Letter Queue(최대 재시도 초과)로 이동한다.
   *
   * ⚠️ Step 3 CongestionControlService.addToNonReady()를 호출하여
   * 혼잡 제어 backoff가 적용된 Non-ready Queue에 넣는다.
   * CongestionControlService를 주입받지 않은 경우 Ready Queue에 직접 넣는다.
   */
  async nack(jobId: string, groupId: string, retryCount: number): Promise<void> {
    // 1. In-flight에서 제거
    await this.redis.zrem('in-flight-queue', jobId);
    await this.redis.del(`in-flight:${jobId}`);

    if (retryCount < this.config.reliableQueue.maxRetryCount) {
      // 2a. 재시도: retryCount 갱신 후 Non-ready Queue로
      await this.redis.hincrby(`job:${jobId}`, 'retryCount', 1);
      await this.redis.hset(`job:${jobId}`, 'status', 'PENDING');

      // Step 3 혼잡 제어 backoff 적용하여 Non-ready Queue에 넣는다.
      // CongestionControlService가 주입되어 있으면 addToNonReady() 사용,
      // 없으면 Ready Queue에 직접 복귀 (backoff 없는 즉시 재시도).
      if (this.congestionControl) {
        await this.congestionControl.addToNonReady(jobId, groupId, retryCount + 1);
      } else {
        await this.redis.rpush('ready-queue', jobId);
      }

      this.logger.debug(
        `NACK job ${jobId}: requeueing (retry ${retryCount + 1}/${this.config.reliableQueue.maxRetryCount})`,
      );
    } else {
      // 2b. Dead Letter: 최대 재시도 초과
      await this.redis.hset(`job:${jobId}`, 'status', 'FAILED');

      const entry = JSON.stringify({
        jobId,
        groupId,
        retryCount,
        error: 'max retries exceeded',
        failedAt: Date.now(),
      });
      await this.redis.rpush('dead-letter-queue', entry);

      this.logger.warn(
        `NACK job ${jobId}: max retries exceeded, moved to Dead Letter`,
      );
    }
  }

  /**
   * ACK deadline을 연장한다 (Heartbeat).
   *
   * 오래 걸리는 작업에서 Worker가 주기적으로 호출하여
   * orphan 판정을 방지한다.
   */
  /**
   * ACK deadline을 연장한다 (Heartbeat).
   *
   * ⚠️ 원자성 문제 수정:
   * 기존 코드는 ZSCORE → ZADD를 별도 명령으로 실행하여,
   * 두 명령 사이에 OrphanRecovery가 ZREM으로 작업을 제거하면
   * ZADD가 이미 복구된 작업을 In-flight에 다시 등록하는 Race condition이 발생한다.
   *
   * Lua 스크립트로 "존재하면 갱신" 을 원자적으로 수행한다.
   */
  async extendDeadline(jobId: string, extensionMs?: number): Promise<boolean> {
    const extension = extensionMs ?? this.config.reliableQueue.ackTimeoutMs;
    const newDeadline = Date.now() + extension;

    // Lua 스크립트로 원자적 갱신: ZSCORE 확인 + ZADD + HSET
    const script = `
      local exists = redis.call('ZSCORE', KEYS[1], ARGV[1])
      if not exists then
        return 0
      end
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
      redis.call('HSET', KEYS[2] .. ':' .. ARGV[1], 'deadline', ARGV[2])
      return 1
    `;

    const result = await this.redis.eval(
      script, 2,
      'in-flight-queue', 'in-flight',
      jobId, newDeadline.toString(),
    );

    const extended = result === 1;

    if (extended) {
      this.logger.debug(`Extended deadline for job ${jobId} to ${new Date(newDeadline).toISOString()}`);
    } else {
      this.logger.warn(
        `extendDeadline failed for job ${jobId}: not in In-flight Queue ` +
        `(이미 OrphanRecovery에 의해 복구되었을 수 있다)`,
      );
    }

    return extended;
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}
```

### Orphan Recovery Service

**`reliable-queue/orphan-recovery.service.ts`**

```typescript
import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

@Injectable()
export class OrphanRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrphanRecoveryService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRecovering = false;

  private stats = {
    totalCycles: 0,
    totalRecovered: 0,
    totalDeadLettered: 0,
  };

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
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
      () => this.recoveryCycle(),
      this.config.reliableQueue.orphanRecoveryIntervalMs,
    );

    this.logger.log(
      `Orphan Recovery started (interval=${this.config.reliableQueue.orphanRecoveryIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.log('Orphan Recovery stopped');
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * 수동으로 1회 복구 사이클을 실행한다 (테스트, 운영용).
   */
  async runOnce(): Promise<{ recovered: number; deadLettered: number }> {
    return this.recoveryCycle();
  }

  // --- Private ---

  private async recoveryCycle(): Promise<{ recovered: number; deadLettered: number }> {
    if (this.isRecovering) return { recovered: 0, deadLettered: 0 };
    this.isRecovering = true;

    try {
      this.stats.totalCycles++;

      const result = await (this.redis as any).recover_orphans(
        'in-flight-queue',
        'ready-queue',
        'dead-letter-queue',
        'in-flight',
        Date.now().toString(),
        this.config.reliableQueue.orphanRecoveryBatchSize.toString(),
        this.config.reliableQueue.maxRetryCount.toString(),
      );

      const recovered = result[0];
      const deadLettered = result[1];

      this.stats.totalRecovered += recovered;
      this.stats.totalDeadLettered += deadLettered;

      if (recovered > 0 || deadLettered > 0) {
        this.logger.log(
          `Orphan recovery: ${recovered} recovered, ${deadLettered} dead-lettered`,
        );
      }

      return { recovered, deadLettered };
    } catch (error) {
      this.logger.error(`Orphan recovery failed: ${error.message}`, error.stack);
      return { recovered: 0, deadLettered: 0 };
    } finally {
      this.isRecovering = false;
    }
  }
}
```

### Dead Letter Service

**`reliable-queue/dead-letter.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

export interface DeadLetterEntry {
  jobId: string;
  groupId?: string;
  retryCount: number;
  error?: string;
  failedAt: number;
}

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);
  private readonly queueKey = 'dead-letter-queue';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * Dead Letter Queue의 크기를 반환한다.
   */
  async size(): Promise<number> {
    return this.redis.llen(this.queueKey);
  }

  /**
   * Dead Letter 목록을 페이지네이션으로 조회한다.
   */
  async list(offset: number = 0, limit: number = 50): Promise<DeadLetterEntry[]> {
    const entries = await this.redis.lrange(this.queueKey, offset, offset + limit - 1);
    return entries.map((e) => JSON.parse(e));
  }

  /**
   * Dead Letter 작업을 Ready Queue로 재투입한다 (수동 재시도).
   *
   * ⚠️ 성능 개선:
   * 기존 코드는 LRANGE(0, -1)로 전체 DLQ를 로드 후 선형 탐색 → O(N).
   * DLQ 크기가 수천 건 이상이면 심각한 성능 문제가 발생한다.
   *
   * 개선 방안: DLQ 보조 인덱스(Hash)를 사용하여 O(1) 조회.
   *   - `dead-letter-index` Hash: jobId → JSON entry
   *   - retry 시 Hash에서 삭제 + List에서 LREM
   *   - List는 순서 보존/페이지네이션용, Hash는 단건 조회용
   *
   * 아래는 보조 인덱스 도입 전의 개선 코드로,
   * 최소한 전체 로드 대신 SCAN 기반 배치 탐색을 수행한다.
   */
  async retry(jobId: string): Promise<boolean> {
    // 배치 단위로 DLQ를 탐색하여 메모리 사용량 제한
    const BATCH_SIZE = 100;
    let offset = 0;

    while (true) {
      const entries = await this.redis.lrange(this.queueKey, offset, offset + BATCH_SIZE - 1);
      if (entries.length === 0) break;

      for (const entry of entries) {
        const parsed: DeadLetterEntry = JSON.parse(entry);
        if (parsed.jobId === jobId) {
          // DLQ에서 제거
          await this.redis.lrem(this.queueKey, 1, entry);

          // Job 상태 리셋
          const jobKey = `job:${jobId}`;
          await this.redis.hmset(jobKey, {
            status: 'PENDING',
            retryCount: '0',
          });

          // Ready Queue에 추가
          await this.redis.rpush('ready-queue', jobId);

          this.logger.log(`Dead letter job ${jobId} requeued for retry`);
          return true;
        }
      }

      offset += entries.length;
      if (entries.length < BATCH_SIZE) break;
    }

    return false;
  }

  /**
   * 전체 Dead Letter를 Ready Queue로 재투입한다 (일괄 재시도).
   */
  async retryAll(): Promise<number> {
    let count = 0;
    let entry: string | null;

    while ((entry = await this.redis.lpop(this.queueKey)) !== null) {
      const parsed: DeadLetterEntry = JSON.parse(entry);

      const jobKey = `job:${parsed.jobId}`;
      await this.redis.hmset(jobKey, {
        status: 'PENDING',
        retryCount: '0',
      });

      await this.redis.rpush('ready-queue', parsed.jobId);
      count++;
    }

    this.logger.log(`Retried all ${count} dead letter jobs`);
    return count;
  }

  /**
   * Dead Letter를 영구 삭제한다.
   *
   * ⚠️ retry()와 동일한 성능 주의사항 적용. 배치 탐색 사용.
   */
  async purge(jobId: string): Promise<boolean> {
    const BATCH_SIZE = 100;
    let offset = 0;

    while (true) {
      const entries = await this.redis.lrange(this.queueKey, offset, offset + BATCH_SIZE - 1);
      if (entries.length === 0) break;

      for (const entry of entries) {
        const parsed: DeadLetterEntry = JSON.parse(entry);
        if (parsed.jobId === jobId) {
          await this.redis.lrem(this.queueKey, 1, entry);
          this.logger.log(`Purged dead letter job ${jobId}`);
          return true;
        }
      }

      offset += entries.length;
      if (entries.length < BATCH_SIZE) break;
    }
    return false;
  }

  /**
   * 오래된 Dead Letter를 정리한다.
   *
   * ⚠️ 배치 탐색으로 전체 로드 방지.
   * LREM 후 인덱스가 변경되므로, 삭제된 항목 수만큼 offset을 보정하지 않는다.
   * (LREM이 1개만 제거하므로, 다음 배치에서 같은 offset부터 다시 읽어도 안전)
   */
  async cleanup(olderThanMs?: number): Promise<number> {
    const threshold = Date.now() - (olderThanMs ?? this.config.reliableQueue.deadLetterRetentionMs);
    const BATCH_SIZE = 100;
    let removed = 0;
    let offset = 0;

    while (true) {
      const entries = await this.redis.lrange(this.queueKey, offset, offset + BATCH_SIZE - 1);
      if (entries.length === 0) break;

      let removedInBatch = 0;
      for (const entry of entries) {
        const parsed: DeadLetterEntry = JSON.parse(entry);
        if (parsed.failedAt < threshold) {
          await this.redis.lrem(this.queueKey, 1, entry);
          removed++;
          removedInBatch++;
        }
      }

      // LREM으로 항목이 제거되면 리스트가 줄어들므로
      // 제거되지 않은 항목 수만큼만 offset을 증가시킨다.
      offset += entries.length - removedInBatch;
      if (entries.length < BATCH_SIZE) break;
    }

    if (removed > 0) {
      this.logger.log(`Cleaned up ${removed} old dead letter entries`);
    }
    return removed;
  }
}
```

### Idempotency Service

**`idempotency/idempotency.service.ts`**

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  /**
   * 작업이 이미 처리되었는지 확인하고, 처리되지 않았다면 마킹한다.
   *
   * SET NX로 원자적으로:
   *   - 키가 없으면 → 생성하고 false 반환 (아직 처리 안 됨)
   *   - 키가 있으면 → true 반환 (이미 처리됨)
   *
   * @param key 멱등성 키 (예: "promotion:customer-A:job-001")
   * @returns true면 이미 처리됨 → 스킵해야 함
   */
  async isProcessed(key: string): Promise<boolean> {
    const ttlSec = Math.ceil(this.config.reliableQueue.idempotencyTtlMs / 1000);
    const result = await this.redis.set(
      `idempotency:${key}`,
      Date.now().toString(),
      'EX',
      ttlSec,
      'NX',
    );

    // SET NX: 'OK'이면 새로 생성됨(처리 안 됨), null이면 이미 존재(처리됨)
    return result !== 'OK';
  }

  /**
   * 멱등성 마킹을 수동으로 제거한다.
   * 작업 결과를 무효화하고 재처리할 때 사용한다.
   */
  async reset(key: string): Promise<boolean> {
    const deleted = await this.redis.del(`idempotency:${key}`);
    return deleted === 1;
  }

  /**
   * 여러 키의 처리 여부를 일괄 확인한다.
   */
  async filterUnprocessed(keys: string[]): Promise<string[]> {
    const unprocessed: string[] = [];

    // 파이프라인으로 일괄 조회
    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.exists(`idempotency:${key}`);
    }
    const results = await pipeline.exec();

    for (let i = 0; i < keys.length; i++) {
      const [err, exists] = results![i];
      if (!err && exists === 0) {
        unprocessed.push(keys[i]);
      }
    }

    return unprocessed;
  }
}
```

### 모듈 등록 (최종)

**`bulk-action.module.ts`**

```typescript
import { DynamicModule, Module } from '@nestjs/common';
// ... 모든 import

@Module({})
export class BulkActionModule {
  static register(config?: Partial<BulkActionConfig>): DynamicModule {
    const mergedConfig = this.mergeConfig(config);

    return {
      module: BulkActionModule,
      providers: [
        { provide: BULK_ACTION_CONFIG, useValue: mergedConfig },
        redisProvider,
        LuaScriptLoader,
        // Step 1: Fair Queue
        FairQueueService,
        // Step 2: Backpressure
        RateLimiterService, ReadyQueueService, NonReadyQueueService, BackpressureService,
        // Step 3: Congestion Control
        CongestionControlService, CongestionStatsService,
        // Step 4: Worker Pool
        FetcherService, DispatcherService, WorkerPoolService,
        // Step 5: Aggregator & Watcher
        DistributedLockService, AggregatorService, WatcherService, DefaultAggregator,
        { provide: AGGREGATOR, useFactory: (d: DefaultAggregator) => [d], inject: [DefaultAggregator] },
        // Step 6: Reliable Queue
        ReliableQueueService,
        InFlightQueueService,
        OrphanRecoveryService,
        DeadLetterService,
        IdempotencyService,
      ],
      exports: [
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        WorkerPoolService,
        AggregatorService,
        DistributedLockService,
        ReliableQueueService,
        DeadLetterService,
        IdempotencyService,
      ],
    };
  }

  // ... registerProcessors, registerAggregators, mergeConfig 생략
}
```

---

## Step 1~5와의 연동

### Worker 변경: pop → reliable dequeue

Step 4의 Worker에서 `readyQueue.blockingPop()`을 `reliableQueue.blockingDequeue()`로 교체한다.

**변경 전 (Step 4):**

```typescript
// worker.ts
private async tick(): Promise<void> {
  const jobId = await this.readyQueue.blockingPop(this.options.timeoutSec);
  if (!jobId) return;
  // ...
}
```

**변경 후 (Step 6):**

```typescript
// worker.ts
private async tick(): Promise<void> {
  // 1. Reliable dequeue: pop + In-flight 등록
  const result = await this.reliableQueue.blockingDequeue(
    `worker-${this.id}`,
    this.options.timeoutSec,
  );
  if (!result) return;

  const { jobId, deadline } = result;
  const job = await this.loadJob(jobId);
  if (!job) {
    await this.reliableQueue.ack(jobId); // 데이터 없는 작업은 ACK로 제거
    return;
  }

  this.currentJob = job;
  const startTime = Date.now();

  try {
    const processor = this.processorMap.get(job.type);
    if (!processor) throw new Error(`No processor for type: ${job.type}`);

    // 2. 실행 (장시간 작업이면 heartbeat 포함)
    const jobResult = await this.executeWithHeartbeat(processor, job, deadline);
    jobResult.durationMs = Date.now() - startTime;

    // 3. ACK (In-flight에서 제거)
    const isNormalAck = await this.reliableQueue.ack(jobId);
    if (!isNormalAck) {
      this.logger.warn(`Late ACK for ${jobId}, result may be duplicated`);
    }

    // 4. 결과 처리
    await this.options.onJobComplete(jobResult);

  } catch (error) {
    // 5. NACK
    await this.reliableQueue.nack(jobId, job.groupId, job.retryCount);
    await this.options.onJobFailed(job, error);
  } finally {
    this.currentJob = null;
  }
}

/**
 * 장시간 작업에서 주기적으로 deadline을 연장한다.
 */
private async executeWithHeartbeat(
  processor: JobProcessor,
  job: Job,
  deadline: number,
): Promise<JobProcessorResponse> {
  const heartbeatInterval = Math.floor(
    this.options.jobTimeoutMs * 0.6, // timeout의 60% 시점마다 연장
  );

  const heartbeat = setInterval(async () => {
    await this.reliableQueue.extendDeadline(job.id);
  }, heartbeatInterval);

  try {
    return await this.executeWithTimeout(processor, job);
  } finally {
    clearInterval(heartbeat);
  }
}
```

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
│  │ │  Reliable Dequeue     │  LPOP + ZADD (원자적)                  │   │
│  │ │  Ready → In-flight    │                                        │   │
│  │ └──────────┬───────────┘                                        │   │
│  │            │                                                    │   │
│  │            ▼                                                    │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Worker ×N            │  Step 4                                │   │
│  │ │  process() + heartbeat│                                        │   │
│  │ └───┬────────────┬─────┘                                        │   │
│  │   성공          실패                                              │   │
│  │     │             │                                              │   │
│  │     ▼             ▼                                              │   │
│  │   ACK           NACK                                            │   │
│  │   (In-flight    (retry < max → Non-ready Queue)                 │   │
│  │    에서 제거)    (retry >= max → Dead Letter Queue)              │   │
│  │     │                                                           │   │
│  │     ▼                                                           │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Aggregator           │  Step 5                                │   │
│  │ │  map() → 중간 결과     │                                        │   │
│  │ └──────────────────────┘                                        │   │
│  │                                                                 │   │
│  │ ┌──────────────────────┐                                        │   │
│  │ │  Orphan Recovery      │  Step 6 ★                              │   │
│  │ │  주기적 스캔            │                                        │   │
│  │ │  timeout → Ready Queue │                                       │   │
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

### ReliableQueueService 통합 테스트

```typescript
describe('ReliableQueueService (Integration)', () => {
  let reliableQueue: ReliableQueueService;
  let inFlightQueue: InFlightQueueService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          reliableQueue: { ackTimeoutMs: 5000, maxRetryCount: 3 },
        }),
      ],
    }).compile();

    reliableQueue = module.get(ReliableQueueService);
    inFlightQueue = module.get(InFlightQueueService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('dequeue 시 Ready Queue에서 제거되고 In-flight에 등록된다', async () => {
    await redis.rpush('ready-queue', 'job-001');

    const result = await reliableQueue.dequeue('worker-0');

    expect(result).not.toBeNull();
    expect(result!.jobId).toBe('job-001');

    // Ready Queue에서 제거됨
    expect(await redis.llen('ready-queue')).toBe(0);

    // In-flight에 등록됨
    expect(await inFlightQueue.isInFlight('job-001')).toBe(true);
  });

  it('ACK 시 In-flight에서 제거된다', async () => {
    await redis.rpush('ready-queue', 'job-001');
    await reliableQueue.dequeue('worker-0');

    const acked = await reliableQueue.ack('job-001');

    expect(acked).toBe(true);
    expect(await inFlightQueue.isInFlight('job-001')).toBe(false);
  });

  it('이미 복구된 작업의 ACK는 false를 반환한다', async () => {
    await redis.rpush('ready-queue', 'job-001');
    await reliableQueue.dequeue('worker-0');

    // 수동으로 In-flight에서 제거 (orphan 복구 시뮬레이션)
    await redis.zrem('in-flight-queue', 'job-001');

    const acked = await reliableQueue.ack('job-001');
    expect(acked).toBe(false); // Late ACK
  });

  it('extendDeadline이 deadline을 갱신한다', async () => {
    await redis.rpush('ready-queue', 'job-001');
    const result = await reliableQueue.dequeue('worker-0');
    const originalDeadline = result!.deadline;

    await sleep(100);

    const extended = await reliableQueue.extendDeadline('job-001');
    expect(extended).toBe(true);

    const newScore = await redis.zscore('in-flight-queue', 'job-001');
    expect(parseInt(newScore!, 10)).toBeGreaterThan(originalDeadline);
  });

  it('Ready Queue가 비어있으면 null을 반환한다', async () => {
    const result = await reliableQueue.dequeue('worker-0');
    expect(result).toBeNull();
  });
});
```

### OrphanRecoveryService 통합 테스트

```typescript
describe('OrphanRecoveryService (Integration)', () => {
  let recovery: OrphanRecoveryService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          reliableQueue: {
            ackTimeoutMs: 1000,
            orphanRecoveryIntervalMs: 100,
            maxRetryCount: 2,
          },
        }),
      ],
    }).compile();

    recovery = module.get(OrphanRecoveryService);
    redis = module.get(REDIS_CLIENT);

    recovery.stop(); // 자동 실행 중지
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('타임아웃된 작업을 Ready Queue로 복구한다', async () => {
    // In-flight에 이미 만료된 작업 등록
    const pastDeadline = Date.now() - 1000;
    await redis.zadd('in-flight-queue', pastDeadline.toString(), 'job-001');
    await redis.hmset('job:job-001', { retryCount: '0', status: 'PROCESSING' });

    const result = await recovery.runOnce();

    expect(result.recovered).toBe(1);
    expect(result.deadLettered).toBe(0);

    // Ready Queue에 복구됨
    const readyJobs = await redis.lrange('ready-queue', 0, -1);
    expect(readyJobs).toContain('job-001');

    // In-flight에서 제거됨
    const inFlight = await redis.zcard('in-flight-queue');
    expect(inFlight).toBe(0);

    // retryCount 증가
    const retryCount = await redis.hget('job:job-001', 'retryCount');
    expect(retryCount).toBe('1');
  });

  it('최대 재시도 초과 작업은 Dead Letter로 이동한다', async () => {
    const pastDeadline = Date.now() - 1000;
    await redis.zadd('in-flight-queue', pastDeadline.toString(), 'job-001');
    await redis.hmset('job:job-001', { retryCount: '2', status: 'PROCESSING' }); // maxRetry=2

    const result = await recovery.runOnce();

    expect(result.recovered).toBe(0);
    expect(result.deadLettered).toBe(1);

    // Dead Letter Queue에 추가됨
    const dlq = await redis.lrange('dead-letter-queue', 0, -1);
    expect(dlq).toHaveLength(1);

    const entry = JSON.parse(dlq[0]);
    expect(entry.jobId).toBe('job-001');
  });

  it('아직 만료되지 않은 작업은 건드리지 않는다', async () => {
    const futureDeadline = Date.now() + 60000;
    await redis.zadd('in-flight-queue', futureDeadline.toString(), 'job-001');

    const result = await recovery.runOnce();

    expect(result.recovered).toBe(0);
    expect(result.deadLettered).toBe(0);

    // In-flight에 그대로 존재
    const inFlight = await redis.zcard('in-flight-queue');
    expect(inFlight).toBe(1);
  });
});
```

### IdempotencyService 테스트

```typescript
describe('IdempotencyService (Integration)', () => {
  let idempotency: IdempotencyService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
          reliableQueue: { idempotencyTtlMs: 5000 },
        }),
      ],
    }).compile();

    idempotency = module.get(IdempotencyService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('첫 호출은 false(처리 안 됨)를 반환한다', async () => {
    const result = await idempotency.isProcessed('promo:customer-A:job-001');
    expect(result).toBe(false);
  });

  it('두 번째 호출은 true(이미 처리됨)를 반환한다', async () => {
    await idempotency.isProcessed('promo:customer-A:job-001');
    const result = await idempotency.isProcessed('promo:customer-A:job-001');
    expect(result).toBe(true);
  });

  it('reset 후에는 다시 false를 반환한다', async () => {
    await idempotency.isProcessed('promo:customer-A:job-001');
    await idempotency.reset('promo:customer-A:job-001');

    const result = await idempotency.isProcessed('promo:customer-A:job-001');
    expect(result).toBe(false);
  });

  it('TTL 만료 후에는 false를 반환한다', async () => {
    await idempotency.isProcessed('promo:customer-A:job-001');

    // TTL 대기 (5초 + 여유)
    await sleep(5500);

    const result = await idempotency.isProcessed('promo:customer-A:job-001');
    expect(result).toBe(false);
  }, 10000);

  it('filterUnprocessed가 미처리 키만 반환한다', async () => {
    await idempotency.isProcessed('key-1'); // 처리됨
    // key-2, key-3은 미처리

    const unprocessed = await idempotency.filterUnprocessed(['key-1', 'key-2', 'key-3']);
    expect(unprocessed).toEqual(['key-2', 'key-3']);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### Dead Letter 관리 테스트

```typescript
describe('DeadLetterService (Integration)', () => {
  let deadLetter: DeadLetterService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 },
        }),
      ],
    }).compile();

    deadLetter = module.get(DeadLetterService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('retry가 DLQ에서 제거하고 Ready Queue에 추가한다', async () => {
    await redis.rpush('dead-letter-queue', JSON.stringify({
      jobId: 'job-001', retryCount: 3, failedAt: Date.now(),
    }));
    await redis.hmset('job:job-001', { status: 'FAILED', retryCount: '3' });

    const retried = await deadLetter.retry('job-001');
    expect(retried).toBe(true);

    expect(await deadLetter.size()).toBe(0);
    expect(await redis.llen('ready-queue')).toBe(1);
    expect(await redis.hget('job:job-001', 'retryCount')).toBe('0');
  });

  it('retryAll이 모든 DLQ 작업을 Ready Queue로 이동한다', async () => {
    for (let i = 0; i < 5; i++) {
      await redis.rpush('dead-letter-queue', JSON.stringify({
        jobId: `job-${i}`, retryCount: 3, failedAt: Date.now(),
      }));
      await redis.hmset(`job:job-${i}`, { status: 'FAILED', retryCount: '3' });
    }

    const count = await deadLetter.retryAll();
    expect(count).toBe(5);
    expect(await deadLetter.size()).toBe(0);
    expect(await redis.llen('ready-queue')).toBe(5);
  });
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

### Step 4/5 연동 인터페이스 정리

Step 6은 Step 4(Worker Pool)와 Step 5(Aggregator) 모두에 영향을 미친다. 교체/추가가 필요한 포인트를 정리한다.

#### Step 4 Worker Pool 교체 포인트

| Step 4 현재 | Step 6 교체 | 파일 |
|-------------|-------------|------|
| `readyQueue.blockingPop()` | `reliableQueue.blockingDequeue()` | worker.ts |
| `handleJobComplete()`: `fairQueue.ack()` 만 호출 | + `reliableQueue.ack(jobId)` | worker-pool.service.ts |
| `handleJobFailed()`: `backpressure.requeue()` | + `reliableQueue.nack(jobId, groupId, retryCount)` | worker-pool.service.ts |
| `handleDeadLetter()`: `fairQueue.ack()` | + `reliableQueue.ack(jobId)` (In-flight에서 제거) | worker-pool.service.ts |
| Graceful Shutdown: Worker 정지 대기 | + 미완료 In-flight 작업 복원 | worker-pool.service.ts |

```typescript
// Step 6 적용 후 handleJobComplete() 최종 형태:
private async handleJobComplete(result: JobProcessorResponse): Promise<void> {
  try {
    // 1. Step 6: In-flight Queue에서 제거 (ACK)
    const isNormalAck = await this.reliableQueue.ack(result.jobId);
    if (!isNormalAck) {
      this.logger.warn(`Late ACK for ${result.jobId}, result may be duplicated`);
    }

    // 2. Step 5: 결과 집계
    if (this.aggregator) {
      await this.aggregator.recordJobResult(result);
    }

    // 3. Step 1: Fair Queue ACK
    const isGroupCompleted = await this.fairQueue.ack(result.jobId, result.groupId);

    // 4. Step 3: 그룹 완료 시 혼잡 통계 리셋
    if (isGroupCompleted) {
      await this.congestionControl.resetGroupStats(result.groupId);
      if (this.aggregator) {
        await this.aggregator.finalizeGroup(result.groupId);
      }
    }
  } catch (error) {
    this.logger.error(`Failed to handle job completion: ${error.message}`, error.stack);
  }
}
```

#### Step 5 Aggregator 연동

Orphan Recovery에서 Dead Letter로 이동된 작업도 Step 5 집계에 반영해야 한다.

```typescript
// OrphanRecoveryService에 AggregatorService 주입:
constructor(
  @Inject(REDIS_CLIENT) private readonly redis: Redis,
  @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  @Optional() private readonly aggregator?: AggregatorService,
) {}

private async recoveryCycle(): Promise<{ recovered: number; deadLettered: number }> {
  // ... 기존 Lua 실행 ...

  const recovered = result[0];
  const deadLettered = result[1];
  // recover_orphans.lua가 반환한 Dead Letter jobId 목록 (Issue #2에서 추가)
  const deadLetteredJobIds: string[] = [];
  for (let i = 2; i < result.length; i++) {
    deadLetteredJobIds.push(result[i]);
  }

  // Step 5 Aggregator: Dead Letter 작업을 실패로 집계
  if (this.aggregator && deadLetteredJobIds.length > 0) {
    for (const jobId of deadLetteredJobIds) {
      const groupId = await this.redis.hget(`job:${jobId}`, 'groupId') ?? '';
      const jobType = await this.redis.hget(`job:${jobId}`, 'type') ?? '';
      await this.aggregator.recordJobResult({
        jobId,
        groupId,
        jobType,
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

  // ... 로깅 및 반환 ...
}
```

#### firstJobStartedAt 갱신 (DISPATCHED → RUNNING 전이 트리거)

Step 5의 Watcher는 `firstJobStartedAt > 0` 조건으로 DISPATCHED → RUNNING 전이를 판단한다.
`blockingDequeue()` 성공 시 Worker가 이 필드를 갱신해야 한다.

```typescript
// Worker.tick() 내, blockingDequeue 성공 후:
const result = await this.reliableQueue.blockingDequeue(workerId, timeoutSec);
if (!result) return;

const job = await this.loadJob(result.jobId);
if (!job) { /* ... */ return; }

// Step 5: DISPATCHED → RUNNING 전이를 위한 firstJobStartedAt 갱신
// HSETNX를 사용하여 첫 번째 Job만 기록한다.
await this.redis.hsetnx(
  `group:${job.groupId}:meta`,
  'firstJobStartedAt',
  Date.now().toString(),
);
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
