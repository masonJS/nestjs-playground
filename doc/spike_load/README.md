# 급증하는 트래픽 안정적으로 처리하기

> [채널톡 기술 블로그 원문](https://channel.io/ko/team/blog/articles/%EA%B8%89%EC%A6%9D%ED%95%98%EB%8A%94-%ED%8A%B8%EB%9E%98%ED%94%BD-%E1%84%8B%E1%85%A1%E1%86%AB%E1%84%8C%E1%85%A5%E1%86%BC%E1%84%8C%E1%85%A5%E1%86%A8%E1%84%8B%E1%85%B3%E1%84%85%E1%85%A9-%E1%84%8E%E1%85%A5%E1%84%85%E1%85%B5%E1%84%92%E1%85%A1%E1%84%80%E1%85%B5-%EA%B5%AC%ED%98%84%ED%8E%B8-235661b0) 분석 및 NestJS 적용 가이드

---

## 원문 분석

### 문제 정의

채널톡이 직면한 **벌크액션** 처리 문제:

| 문제 | 설명 |
|------|------|
| 스파이크 로드 | 임의 시점에 대규모 요청이 몰림 (100만 고객 업로드, 10만 프로모션 등) |
| 요청 손실 | 대량 요청 중 유실 발생 가능성 |
| Head-of-line Blocking | 대형 고객사 요청이 다른 고객사 요청을 지연시킴 |
| 비일관적 구현 | 기능별로 벌크 처리 방식이 제각각 |
| 서비스 품질 저하 | 특정 고객사 벌크 요청이 전체 서비스에 영향 |

### 아키텍처 개요

```
[Client Request]
       │
       ▼
┌─────────────┐
│  Fair Queue  │  ← 고객사별 공정한 큐 운영
│  (3개 큐)    │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────┐
│  Backpressure & Rate Limit  │  ← Fixed Window RPS 제한
│  ┌───────────┬────────────┐ │
│  │Ready Queue│Non-ready Q │ │
│  └───────────┴────────────┘ │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│     혼잡 제어 (Congestion)   │  ← 동적 대기시간 계산
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Worker Pool                │  ← Fetcher / Worker / Dispatcher
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Aggregator & Watcher       │  ← MapReduce 결과 집계 + 상태 전이
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  실패 처리 (ACK / Retry)     │  ← At-least-once, Reliable Queue
└─────────────────────────────┘
```

### 핵심 알고리즘

**1. Fair Queueing 우선순위 계산**

```
priority = (-1 * now_ms) + base_priority + ALPHA * (-1 + total_jobs / max(1, total_jobs - done_jobs))
```

- `now_ms`: 현재 시각 → 오래된 요청일수록 높은 우선순위
- `base_priority`: 고객사별 기본 우선순위
- 마지막 항: SJF(Shortest Job First) → 남은 작업이 적은 그룹 우선

**2. Rate Limiting (Fixed Window)**

```
전체 RPS = 10,000
고객사 N개 → 고객사당 RPS = 10,000 / N
```

**3. 혼잡 제어 동적 대기시간**

```
대기시간 = 1초 + floor(Non-ready Queue 내 해당 rate limit 작업 수 / rate limit 속도)
```

---

## NestJS 구현 단계

### 사전 준비

현재 프로젝트는 NestJS 9 + TypeORM + PostgreSQL 기반 모노레포 구조.
벌크액션 시스템을 `libs/bulk-action/` 라이브러리로 구현한다.

추가 의존성:
- `ioredis` - Redis 클라이언트
- `redlock` - 분산락

---

### Step 1. Redis 기반 Fair Queue 구현

> 고객사별 공정한 작업 분배를 위한 큐 시스템

**구현 범위:**
- Redis Sorted Set 기반 우선순위 큐
- Lua 스크립트를 통한 원자적 enqueue/dequeue 연산
- 고객사(group)별 우선순위 계산 로직 (SJF 포함)
- 3개 큐 운영: High / Normal / Low priority

**핵심 구현 포인트:**
```typescript
// 우선순위 계산
function calculatePriority(group: JobGroup): number {
  const now = -1 * Date.now();
  const basePriority = group.config.basePriority;
  const { totalJobs, doneJobs } = group;
  const sjfBoost = ALPHA * (-1 + totalJobs / Math.max(1, totalJobs - doneJobs));
  return now + basePriority + sjfBoost;
}
```

**필요 모듈:**
- `BulkActionModule` - 루트 모듈
- `FairQueueService` - 큐 관리 서비스
- `RedisLuaScriptLoader` - Lua 스크립트 로더

---

### Step 2. Backpressure & Rate Limiting

> Ready Queue / Non-ready Queue 이원화 및 RPS 제한

**구현 범위:**
- Fixed Window 알고리즘 기반 Rate Limiter
- Ready Queue: 즉시 실행 가능한 작업 관리
- Non-ready Queue: 쓰로틀링/에러 작업 관리 (Redis Sorted Set, score = backoff 시간)
- 고객사별 동적 RPS 할당

**핵심 구현 포인트:**
```typescript
// Rate Limiter - Redis INCR + EXPIRE 조합
class FixedWindowRateLimiter {
  async isAllowed(groupId: string): Promise<boolean> {
    const key = `ratelimit:${groupId}:${currentWindow()}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 1);
    return count <= this.getLimit(groupId);
  }
}
```

**필요 모듈:**
- `RateLimiterService` - Fixed Window Rate Limiter
- `ReadyQueueService` - 실행 가능 작업 큐
- `NonReadyQueueService` - 대기 작업 큐

---

### Step 3. 혼잡 제어 (Congestion Control)

> 공회전 문제 해결을 위한 동적 대기시간 계산

**구현 범위:**
- Non-ready Queue 내 작업 수 기반 동적 backoff 시간 계산
- Ready ↔ Non-ready 큐 간 작업 이동 최적화
- 쓰로틀링 횟수 최소화

**핵심 구현 포인트:**
```typescript
// 동적 대기시간 계산
function calculateBackoffTime(nonReadyCount: number, rateLimitSpeed: number): number {
  return 1000 + Math.floor(nonReadyCount / rateLimitSpeed) * 1000; // ms
}
```

**기대 성능 (원문 부하 테스트 결과):**
- 15,000개 작업, 10TPS 기준: 이상적 500초 → 실제 ~720초 (오차 +44%)
- 평균 쓰로틀링 횟수: 1.45회/작업 (기존 수십 회 대비 대폭 감소)

---

### Step 4. Worker Pool 구현

> Fetcher / Worker / Dispatcher 3역할 분리

**구현 범위:**
- Fetcher: 주기적으로 Fair Queue에서 작업을 폴링하여 Ready Queue에 할당
- Worker: Ready Queue에서 작업을 꺼내 실행
- Dispatcher: Non-ready Queue → Ready Queue 이동 담당
- 고정 워커 수 설정 + 동적 스케일링 고려

**핵심 구현 포인트:**
```typescript
@Injectable()
class WorkerPoolService implements OnModuleInit {
  private readonly workers: Worker[] = [];

  async onModuleInit() {
    for (let i = 0; i < this.config.workerCount; i++) {
      this.workers.push(new Worker(this.readyQueue, this.jobProcessor));
    }
    this.startFetcher();
    this.startDispatcher();
  }
}
```

**필요 모듈:**
- `WorkerPoolService` - 워커 풀 관리
- `FetcherService` - 작업 폴링
- `DispatcherService` - Non-ready → Ready 이동
- `JobProcessorService` - 실제 작업 실행 인터페이스

---

### Step 5. Aggregator & Watcher 구현

> MapReduce 기반 결과 집계 + 상태 전이 감시

**구현 범위:**
- MapReduce 인터페이스로 작업 결과 집계
- Watcher: 그룹 상태 전이 감시
  - `CREATED → DISPATCHED` (모든 job 수신 확인)
  - `RUNNING → AGGREGATING` (모든 job 완료 확인)
  - `AGGREGATING → COMPLETED` (결과 집계 완료)
- 분산락으로 다중 인스턴스 경합 방지

**핵심 구현 포인트:**
```typescript
// 상태 전이 머신
enum GroupStatus {
  CREATED = 'CREATED',
  DISPATCHED = 'DISPATCHED',
  RUNNING = 'RUNNING',
  AGGREGATING = 'AGGREGATING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

interface Aggregator<T, R> {
  map(job: Job): T;
  reduce(results: T[]): R;
}
```

**필요 모듈:**
- `AggregatorService` - MapReduce 결과 집계
- `WatcherService` - 상태 전이 감시
- `DistributedLockService` - Redis 기반 분산락 (Redlock)

---

### Step 6. 실패 처리 (Reliable Queue + ACK)

> At-least-once semantic 보장

**구현 범위:**
- ACK 메커니즘: Ready Queue에서 pop 시 In-flight Queue에 timeout과 함께 등록
- Timeout 내 ACK 미수신 → orphaned job으로 판정 → Ready Queue 복구
- 재시도 로직 (최대 재시도 횟수 설정)
- 멱등성은 각 Job Handler에서 보장 (클라이언트 책임)

**핵심 구현 포인트:**
```typescript
class ReliableQueueService {
  async dequeue(): Promise<Job | null> {
    // 1. Ready Queue에서 pop
    const job = await this.readyQueue.pop();
    if (!job) return null;

    // 2. In-flight Queue에 timeout과 함께 등록
    await this.inflightQueue.add(job, { timeout: this.ackTimeout });
    return job;
  }

  async ack(jobId: string): Promise<void> {
    await this.inflightQueue.remove(jobId);
  }

  // Dispatcher가 주기적으로 호출
  async recoverOrphanedJobs(): Promise<void> {
    const orphaned = await this.inflightQueue.getTimedOut();
    for (const job of orphaned) {
      await this.readyQueue.push(job);
      await this.inflightQueue.remove(job.id);
    }
  }
}
```

**필요 모듈:**
- `ReliableQueueService` - ACK 기반 안정적 큐
- `InFlightQueueService` - 실행 중 작업 추적

---

## 구현 순서 요약

```
Step 1. Fair Queue          ← 기반 인프라 (Redis Sorted Set + Lua)
   │
   ▼
Step 2. Rate Limiting       ← Ready / Non-ready Queue 이원화
   │
   ▼
Step 3. Congestion Control  ← 동적 backoff로 공회전 방지
   │
   ▼
Step 4. Worker Pool         ← Fetcher / Worker / Dispatcher
   │
   ▼
Step 5. Aggregator/Watcher  ← 결과 집계 + 상태 관리
   │
   ▼
Step 6. Reliable Queue      ← ACK + 실패 복구
```

## 향후 고려 사항

원문에서 아직 다루지 않은 영역:

- **동적 흐름 제어**: 실시간 부하에 따른 RPS 자동 조절
- **중복 요청 제거**: 클라이언트 요청에 deduplication ID 부여
- **Job Queue 수평 확장**: 단일 Redis 한계 극복을 위한 샤딩/클러스터링

## 참고

- 원문은 Go 기반 구현이며, 이 프로젝트에서는 NestJS + TypeScript + Redis로 재구현
- Go의 goroutine/channel → NestJS의 Worker Pool 또는 Bull Queue로 대체
- Redis Sorted Set + Lua 스크립트 패턴은 언어 무관하게 동일 적용 가능
