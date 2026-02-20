# Step 4. Worker Pool 구현

> Fetcher / Worker / Dispatcher 3역할 분리

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [3역할 아키텍처](#3역할-아키텍처)
3. [Go goroutine/channel → NestJS 매핑](#go-goroutinechannel--nestjs-매핑)
4. [NestJS 모듈 구조](#nestjs-모듈-구조)
5. [구현 코드](#구현-코드)
6. [Step 1~3과의 연동](#step-13과의-연동)
7. [Graceful Shutdown](#graceful-shutdown)
8. [테스트 전략](#테스트-전략)
9. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### Worker Pool이란?

Worker Pool은 **고정된 수의 워커를 미리 생성해두고 작업을 분배하는 동시성 패턴**이다. 작업마다 스레드/프로세스를 생성하는 것보다 효율적이다.

```
작업을 하나씩 직접 처리:
  요청 → 처리 → 응답 → 요청 → 처리 → 응답
  (직렬, 느림)

Worker Pool:
  요청 ──┬── Worker 1 ── 처리 ── 완료
         ├── Worker 2 ── 처리 ── 완료
         ├── Worker 3 ── 처리 ── 완료
         └── Worker N ── 처리 ── 완료
  (병렬, 빠름, 리소스 제한됨)
```

### 왜 3역할 분리인가?

단일 루프로 "큐에서 꺼내서 처리"를 반복하면 다음 문제가 생긨다:

| 단일 루프 문제 | 3역할 분리 해결 |
|--------------|---------------|
| Fair Queue polling과 작업 실행이 결합 | Fetcher가 polling 전담, Worker가 실행 전담 |
| Non-ready → Ready 이동이 지연 | Dispatcher가 이동 전담 |
| polling 주기와 실행 시간이 상호 간섭 | 각 역할이 독립적 주기로 동작 |
| 장애 격리 불가 | 한 역할이 느려져도 다른 역할에 영향 없음 |

```
┌──────────────────────────────────────────────────────────┐
│                     Worker Pool                          │
│                                                          │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────┐    │
│  │ Fetcher  │    │  Ready      │    │  Worker ×N   │    │
│  │          │───▶│  Queue      │───▶│              │    │
│  │ Fair Q → │    │  (List)     │    │  실행 엔진    │    │
│  │ Rate Lim │    └─────────────┘    └──────────────┘    │
│  └──────────┘           ▲                               │
│                         │                               │
│                  ┌──────┴───────┐                        │
│                  │  Dispatcher  │                        │
│                  │              │                        │
│                  │ Non-ready →  │                        │
│                  │ Ready 이동   │                        │
│                  └──────────────┘                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 각 역할의 책임

| 역할 | 책임 | 실행 방식 | 주기 |
|------|------|----------|------|
| **Fetcher** | Fair Queue에서 작업을 꺼내 Rate Limit 검사 후 Ready/Non-ready Queue 분배 | AbortController 기반 async loop | 100~500ms |
| **Worker** | Ready Queue에서 작업을 꺼내 실제 비즈니스 로직 실행 | 블로킹 pop (BLPOP) | 연속 |
| **Dispatcher** | Non-ready Queue에서 backoff 만료 작업을 Ready Queue로 이동 | AbortController 기반 async loop | 100ms |

---

## 3역할 아키텍처

### 상세 흐름도

```
                    ┌─────────────────────────────┐
                    │         Fetcher              │
                    │                              │
                    │  while (readyQueue 여유) {    │
                    │    job = fairQueue.dequeue() │
                    │    if (!job) sleep & retry   │
                    │    backpressure.admit(job)   │
                    │  }                           │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │       Ready Queue (List)      │
                    │  ┌───┬───┬───┬───┬───┬───┐   │
                    │  │j01│j02│j03│j04│j05│...│   │
                    │  └───┴───┴───┴───┴───┴───┘   │
                    └──────────┬───────────────────┘
                               │ BLPOP
             ┌─────────────────┼─────────────────┐
             │                 │                  │
     ┌───────▼──────┐ ┌───────▼──────┐ ┌────────▼─────┐
     │  Worker #1   │ │  Worker #2   │ │  Worker #N   │
     │              │ │              │ │              │
     │ job = pop()  │ │ job = pop()  │ │ job = pop()  │
     │ process(job) │ │ process(job) │ │ process(job) │
     │ ack(job)     │ │ ack(job)     │ │ ack(job)     │
     └──────────────┘ └──────────────┘ └──────────────┘
             │                 │                  │
             └─────────────────┼──────────────────┘
                               │ 실패 시
                    ┌──────────▼───────────────────┐
                    │    Non-ready Queue (ZSet)     │
                    │  score = 재시도 가능 시각        │
                    └──────────┬───────────────────┘
                               │ backoff 만료
                    ┌──────────▼───────────────────┐
                    │       Dispatcher              │
                    │                              │
                    │  매 100ms:                    │
                    │    score <= now인 작업 조회     │
                    │    → Ready Queue로 이동        │
                    └──────────────────────────────┘
```

### Fetcher 상세 동작

```
Fetcher 1회 사이클:

  1. Ready Queue 여유 공간 확인
     └─ LLEN(ready-queue) < maxSize? → 아니면 대기

  2. Fair Queue에서 작업 꺼냄
     └─ fairQueue.dequeue() → Job | null

  3. Rate Limit 검사 (Step 2)
     ├─ allowed  → Ready Queue에 추가
     └─ denied   → 혼잡 제어 backoff 계산 (Step 3)
                   → Non-ready Queue에 추가

  4. 배치 단위로 반복 (fetchBatchSize개까지)

  5. Fair Queue가 비었거나 Ready Queue가 가득 차면 대기 후 재시도
```

### Worker 상세 동작

```
Worker 생애주기:

  시작 → 루프 진입
         │
         ▼
  ┌─── BLPOP(ready-queue, timeout) ◄──────────────┐
  │      │                                         │
  │      ├── null (timeout) → 계속 대기             │
  │      │                                         │
  │      └── job 획득                               │
  │           │                                    │
  │           ▼                                    │
  │    jobProcessor.process(job)                   │
  │           │                                    │
  │      ┌────┴─────┐                              │
  │    성공        실패                              │
  │      │          │                              │
  │      ▼          ▼                              │
  │   fairQueue   retryCount < maxRetry?           │
  │    .ack()       ├── yes → Non-ready Queue      │
  │      │          └── no  → Dead Letter Queue    │
  │      │                                         │
  │      └────────────────┬────────────────────────┘
  │                       │
  │                  다음 루프
  │
  종료 신호 수신 → 현재 작업 완료 후 루프 탈출
```

### BLPOP (Blocking Left Pop)

Worker가 Ready Queue에서 작업을 꺼낼 때 사용하는 `BLPOP`은 Redis의 **블로킹 리스트 팝** 명령어다.

#### LPOP vs BLPOP 비교

| | LPOP | BLPOP |
|---|---|---|
| 큐가 비어있을 때 | 즉시 `null` 반환 | 데이터가 들어올 때까지 **대기** |
| 폴링 필요 여부 | 반복 호출 필요 (busy polling) | 불필요 (이벤트 기반) |
| Redis/CPU 부하 | 빈 큐에 계속 요청 → 낭비 | 대기 중 부하 거의 없음 |

#### 동작 방식

```
BLPOP ready-queue 5

1. ready-queue 리스트의 왼쪽(head)에서 꺼냄
2. 큐에 데이터가 있으면 → 즉시 반환
3. 큐가 비어있으면 → 최대 5초간 블로킹 대기
4. 5초 내에 다른 클라이언트가 RPUSH/LPUSH하면 → 즉시 깨어나서 반환
5. 5초 지나도 데이터 없으면 → null 반환
```

#### 왜 LPOP이 아닌 BLPOP인가?

LPOP을 사용하면 큐가 빈 동안 반복 호출(busy polling)이 필요하다:

```typescript
// ❌ busy polling — CPU와 Redis를 낭비
while (running) {
  const job = await redis.lpop('ready-queue');
  if (!job) {
    await sleep(100); // 임의 대기... 반응도 느림
    continue;
  }
  process(job);
}
```

BLPOP은 작업이 들어오는 즉시 반응하면서도 대기 중 부하가 없다:

```typescript
// ✅ 블로킹 — 작업이 들어오는 즉시 반응, 대기 중 부하 없음
while (running) {
  const job = await redis.blpop('ready-queue', 5);
  if (!job) continue; // timeout, 루프 재진입 (shutdown 체크)
  process(job);
}
```

#### timeout이 필요한 이유

timeout 없이 영원히 블로킹하면 **Graceful Shutdown 시 Worker가 루프를 빠져나올 수 없다**.
timeout(기본 `workerTimeoutSec=5`)마다 루프로 돌아와 `this.state === RUNNING` 조건을 체크하고,
STOPPING 상태이면 루프를 탈출한다.

```
Worker 루프:
  BLPOP(5초) → timeout → state 확인 → RUNNING이면 다시 BLPOP
                                     → STOPPING이면 루프 탈출
```

> Go의 `<-jobs`(channel receive)도 데이터가 올 때까지 goroutine을 블로킹한다.
> BLPOP은 동일한 역할을 하되, Redis를 거치므로 **여러 인스턴스에서 동시에 소비**할 수 있다는 점이 다르다.

### Worker 수 결정 기준

```
최적 Worker 수 = 동시 처리 가능한 작업 수

고려 요소:
  1. 외부 API 동시 연결 제한
     - 외부 서비스가 100 concurrent 허용 → Worker ≤ 100

  2. Node.js 이벤트 루프 부하
     - I/O 바운드 작업: Worker 수 = 수백 가능 (비동기)
     - CPU 바운드 작업: Worker 수 = CPU 코어 수 이하

  3. 메모리 제약
     - Worker 1개당 메모리 오버헤드 (작업 데이터 크기 의존)
     - 총 메모리 = Worker 수 × 작업당 메모리

  4. Rate Limit 대비 실행 시간
     - RPS=100, 작업 평균 50ms → 5개 Worker면 충분
     - RPS=100, 작업 평균 500ms → 50개 Worker 필요
```

---

## Go goroutine/channel → NestJS 매핑

원문(채널톡)은 Go로 구현되어 goroutine과 channel을 활용한다. NestJS(Node.js)에서는 다른 패턴으로 동일한 효과를 구현한다.

### 동시성 모델 비교

| Go | Node.js / NestJS | 비고 |
|----|-------------------|------|
| goroutine | `async` 함수 | Node.js는 싱글 스레드지만 I/O 비동기로 동시성 달성 |
| channel | Redis List (BLPOP) | 프로세스 간 통신은 Redis로, 인프로세스는 EventEmitter |
| `select` | `Promise.race` | 여러 비동기 작업 중 먼저 완료된 것 선택 |
| `sync.WaitGroup` | `Promise.all` | 여러 작업 완료 대기 |
| `context.WithCancel` | `AbortController` | 취소 신호 전파 |
| `sync.Mutex` | Redis Lock (Redlock) | 분산 환경에서는 Redis Lock 사용 |
| bounded channel | Ready Queue maxSize | 채널 크기 제한 = 큐 크기 제한 |

### 핵심 패턴 매핑

**Go: goroutine + channel**

```go
// Go 원문 (개념적)
jobs := make(chan Job, 100) // bounded channel

// Fetcher goroutine
go func() {
    for {
        job := fairQueue.Dequeue()
        jobs <- job // 채널이 가득 차면 블로킹
    }
}()

// Worker goroutines
for i := 0; i < workerCount; i++ {
    go func() {
        for job := range jobs {
            process(job)
        }
    }()
}
```

**NestJS: async + Redis BLPOP**

```typescript
// NestJS 매핑
// Ready Queue = bounded channel 역할
// BLPOP = channel receive (<-jobs) 역할
// async 함수 = goroutine 역할

// Fetcher
async fetchLoop(): Promise<void> {
  while (!this.isShutdown) {
    if (!await this.readyQueue.hasCapacity()) {
      await this.sleep(100); // channel full → 대기
      continue;
    }
    const job = await this.fairQueue.dequeue();
    if (job) await this.backpressure.admit(job);
  }
}

// Worker
async workerLoop(): Promise<void> {
  while (!this.isShutdown) {
    const jobId = await this.readyQueue.blockingPop(5); // BLPOP = <-jobs
    if (jobId) await this.processJob(jobId);
  }
}
```

### Node.js에서의 "병렬" 실행

Node.js는 싱글 스레드이므로 CPU 바운드 작업은 병렬화되지 않는다. 하지만 벌크액션의 작업 대부분은 **I/O 바운드**(외부 API 호출, DB 쿼리)이므로, `async/await`로 충분한 동시성을 달성한다.

```
Worker 10개가 동시에 외부 API 호출:

시간 →
Worker 1: ├── API 호출 (I/O 대기) ──┤ 처리 완료
Worker 2: ├── API 호출 (I/O 대기) ──┤ 처리 완료
Worker 3: ├── API 호출 (I/O 대기) ──┤ 처리 완료
...
Worker 10: ├── API 호출 (I/O 대기) ──┤ 처리 완료

→ 이벤트 루프가 10개의 I/O를 동시에 관리
→ 실질적으로 10개 goroutine과 동일한 효과
```

CPU 바운드 작업이 필요한 경우 `worker_threads`나 별도 프로세스로 분리한다.

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/src/
├── worker-pool/
│   ├── WorkerPoolService.ts              # 워커 풀 오케스트레이터
│   ├── FetcherService.ts                 # Fair Queue → Ready/Non-ready 분배
│   └── Worker.ts                         # 개별 Worker 클래스
├── backpressure/
│   └── DispatcherService.ts              # Non-ready → Ready 이동 (기존 위치 유지)
├── config/
│   └── BulkActionConfig.ts               # workerPool 설정 추가
├── model/
│   ├── BulkActionRequest.ts              # 작업 등록 요청 DTO
│   ├── WorkerState.ts                    # Worker 상태 열거형
│   ├── job/
│   │   ├── Job.ts                        # Job 클래스
│   │   └── type/
│   │       └── JobStatus.ts              # Job 상태 열거형
│   ├── job-group/
│   │   ├── JobGroup.ts                   # 작업 그룹 인터페이스
│   │   └── type/
│   │       ├── GroupStatus.ts
│   │       └── PriorityLevel.ts
│   └── job-processor/
│       ├── JobProcessor.ts               # 작업 처리 인터페이스 + JOB_PROCESSOR 토큰
│       └── dto/
│           └── JobProcessorResponse.ts   # 작업 결과 인터페이스
├── processor/
│   ├── EmailProcessor.ts                 # 이메일 발송 프로세서
│   └── PushNotificationProcessor.ts      # 푸시 알림 프로세서
└── BulkActionService.ts                  # 벌크액션 서비스 (작업 등록·조회)
```

### 설정 확장

**`config/BulkActionConfig.ts`** (Step 3에서 확장)

```typescript
// 기존 인터페이스에 workerPool 추가
export interface WorkerPoolConfig {
  workerCount: number;           // Worker 수 (default: 10)
  fetchIntervalMs: number;       // Fetcher 폴링 주기 (default: 200)
  fetchBatchSize: number;        // Fetcher 1회 최대 fetch 수 (default: 50)
  workerTimeoutSec: number;      // Worker BLPOP timeout (default: 5)
  jobTimeoutMs: number;          // 작업 실행 제한시간 (default: 30000)
  maxRetryCount: number;         // 최대 재시도 횟수 (default: 3)
  shutdownGracePeriodMs: number; // Graceful Shutdown 대기시간 (default: 30000)
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;   // Step 4 추가
}

// 기존 DEFAULT_FAIR_QUEUE_CONFIG, DEFAULT_BACKPRESSURE_CONFIG, DEFAULT_CONGESTION_CONFIG과 동일 패턴
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

### Job Result 모델

**`model/job-processor/dto/JobProcessorResponse.ts`**

```typescript
export interface JobProcessorResponse {
  jobId: string;
  groupId: string;
  success: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
    retryable: boolean;
  };
  durationMs: number;
}
```

### Job Processor 인터페이스

**`model/job-processor/JobProcessor.ts`**

```typescript
import { Job } from '../job/Job';
import { JobProcessorResponse } from './dto/JobProcessorResponse';

export interface JobProcessor {
  readonly type: string;

  process(job: Job): Promise<JobProcessorResponse>;
}

export const JOB_PROCESSOR = Symbol('JOB_PROCESSOR');
```

### Worker 클래스

**`worker-pool/Worker.ts`**

```typescript
import { setTimeout } from 'timers/promises';
import { Logger } from '@nestjs/common';
import { ReadyQueueService } from '../backpressure/ReadyQueueService';
import { Job } from '../model/job/Job';
import { JobProcessor } from '../model/job-processor/JobProcessor';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { WorkerState } from '../model/WorkerState';

export class Worker {
  private readonly logger: Logger;
  private state: WorkerState = WorkerState.IDLE;
  private currentJob: Job | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    readonly id: number,
    private readonly readyQueue: ReadyQueueService,
    private readonly processorMap: Map<string, JobProcessor>,
    private readonly options: {
      timeoutSec: number;
      jobTimeoutMs: number;
      onJobComplete: (result: JobProcessorResponse) => Promise<void>;
      onJobFailed: (job: Job, error: Error) => Promise<void>;
      loadJobData: (jobId: string) => Promise<Record<string, string> | null>;
    },
  ) {
    this.logger = new Logger(`Worker-${id}`);
  }

  start(): void {
    if (this.state !== WorkerState.IDLE) {
      return;
    }

    this.state = WorkerState.RUNNING;
    this.loopPromise = this.loop();
    this.logger.debug('Worker started');
  }

  async stop(): Promise<void> {
    if (this.state === WorkerState.STOPPED) {
      return;
    }

    this.state = WorkerState.STOPPING;
    this.logger.debug('Worker stopping...');

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.state = WorkerState.STOPPED;
    this.logger.debug('Worker stopped');
  }

  getState(): WorkerState {
    return this.state;
  }

  getCurrentJob(): Job | null {
    return this.currentJob;
  }

  private async loop(): Promise<void> {
    while (this.state === WorkerState.RUNNING) {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error(
          `Worker loop error: ${(error as Error).message}`,
          (error as Error).stack,
        );
        await setTimeout(1000);
      }
    }
  }

  private async tick(): Promise<void> {
    // 1. Ready Queue에서 블로킹으로 작업 꺼냄
    const jobId = await this.readyQueue.blockingPop(this.options.timeoutSec);

    if (!jobId) {
      // timeout — 큐가 비어있음. STOPPING이면 루프 탈출

      return;
    }

    // 2. 작업 데이터 로드
    const job = await this.loadJob(jobId);

    if (!job) {
      this.logger.warn(`Job ${jobId} not found, skipping`);

      return;
    }

    this.currentJob = job;
    const startTime = Date.now();

    try {
      // 3. 프로세서 선택
      const processor = this.processorMap.get(job.processorType);

      if (!processor) {
        throw new Error(
          `No processor registered for job type: ${job.processorType}`,
        );
      }

      // 4. 타임아웃 + 실행
      const result = await this.executeWithTimeout(processor, job);
      result.durationMs = Date.now() - startTime;

      // 5. 결과 처리
      if (result.success) {
        await this.options.onJobComplete(result);
      } else if (result.error?.retryable) {
        await this.options.onJobFailed(job, new Error(result.error.message));
      } else {
        // 재시도 불가능한 오류 → 재시도 없이 완료 처리
        await this.options.onJobComplete(result);
      }
    } catch (error) {
      this.logger.error(
        `Job ${jobId} failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.options.onJobFailed(job, error as Error);
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * 작업을 타임아웃과 함께 실행한다.
   *
   * AbortController를 사용하여 타이머를 관리한다.
   * processor가 먼저 완료되면 ac.abort()로 타이머를 즉시 정리하여
   * 좀비 타이머 누적을 방지한다.
   */
  private async executeWithTimeout(
    processor: JobProcessor,
    job: Job,
  ): Promise<JobProcessorResponse> {
    const ac = new AbortController();

    const timeoutPromise = setTimeout(this.options.jobTimeoutMs, null, {
      signal: ac.signal,
    }).then<never>(() => {
      throw new Error(
        `Job ${job.id} timed out after ${this.options.jobTimeoutMs}ms`,
      );
    });

    // abort 시 reject되는 Promise의 unhandled rejection 방지
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    timeoutPromise.catch(() => {});

    try {
      return await Promise.race([processor.process(job), timeoutPromise]);
    } finally {
      ac.abort();
    }
  }

  /**
   * Redis에서 작업 데이터를 로드한다.
   *
   * Job class의 constructor에 HGETALL 결과를 전달하여 인스턴스를 생성한다.
   */
  private async loadJob(jobId: string): Promise<Job | null> {
    const data = await this.options.loadJobData(jobId);

    if (!data || !data.id) {
      return null;
    }

    return new Job(data);
  }
}
```

### Fetcher Service

**`worker-pool/FetcherService.ts`**

```typescript
import { setTimeout } from 'timers/promises';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { BackpressureDestination } from '@app/bulk-action/backpressure/dto/BackpressureDto';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { FairQueueService } from '../fair-queue/FairQueueService';
import { BackpressureService } from '../backpressure/BackpressureService';
import { ReadyQueueService } from '../backpressure/ReadyQueueService';

export interface FetcherStats extends Record<string, number> {
  totalFetched: number;
  totalAdmittedReady: number;
  totalAdmittedNonReady: number;
  totalRejected: number;
  totalEmptyPolls: number;
}

@Injectable()
export class FetcherService implements OnModuleDestroy {
  private readonly logger = new Logger(FetcherService.name);
  private abortController: AbortController | null = null;

  private stats = {
    totalFetched: 0,
    totalAdmittedReady: 0,
    totalAdmittedNonReady: 0,
    totalRejected: 0,
    totalEmptyPolls: 0,
  };

  constructor(
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly fairQueue: FairQueueService,
    private readonly backpressure: BackpressureService,
    private readonly readyQueue: ReadyQueueService,
  ) {}

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.abortController) {
      return;
    }

    this.abortController = new AbortController();
    void this.runLoop();

    this.logger.log(
      `Fetcher started (interval=${this.config.workerPool.fetchIntervalMs}ms, ` +
        `batchSize=${this.config.workerPool.fetchBatchSize})`,
    );
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.logger.log('Fetcher stopped');
  }

  isRunning(): boolean {
    return this.abortController !== null;
  }

  getStats(): FetcherStats {
    return { ...this.stats };
  }

  // --- Private ---

  private async runLoop(): Promise<void> {
    const signal = this.abortController?.signal;

    while (!signal?.aborted) {
      await this.fetchCycle();

      try {
        await setTimeout(this.config.workerPool.fetchIntervalMs, undefined, {
          signal,
        });
      } catch {
        break;
      }
    }
  }

  private async fetchCycle(): Promise<void> {
    try {
      let fetched = 0;

      while (fetched < this.config.workerPool.fetchBatchSize) {
        // 1. Ready Queue 여유 확인
        const hasCapacity = await this.readyQueue.hasCapacity();

        if (!hasCapacity) {
          this.logger.debug('Ready Queue full, pausing fetch cycle');
          break;
        }

        // 2. Fair Queue에서 작업 꺼냄
        const job = await this.fairQueue.dequeue();

        if (!job) {
          this.stats.totalEmptyPolls++;
          break;
        }

        // 3. Backpressure 검사 (Rate Limit + 혼잡 제어)
        const result = await this.backpressure.admit(job);

        // 4. 통계 갱신
        this.stats.totalFetched++;

        if (result.destination === BackpressureDestination.READY) {
          this.stats.totalAdmittedReady++;
        } else if (result.destination === BackpressureDestination.NON_READY) {
          this.stats.totalAdmittedNonReady++;
        } else {
          this.stats.totalRejected++;
        }

        if (!result.accepted) {
          break;
        }

        fetched++;
      }

      if (fetched > 0) {
        this.logger.debug(`Fetched ${fetched} jobs`);
      }
    } catch (error) {
      this.logger.error(
        `Fetch cycle failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
```

### Dispatcher Service (Step 2 기존 코드 확장)

**`backpressure/DispatcherService.ts`** (기존 위치 유지)

Step 2에서 구현한 Dispatcher를 Step 4에서 통계 추적 기능으로 확장한다.
`AbortController` 기반 async loop로 동작하며, `dispatching` 가드 플래그로 중복 실행을 방지한다.

```typescript
import { setTimeout } from 'timers/promises';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { ReadyQueueService } from './ReadyQueueService';

@Injectable()
export class DispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private abortController: AbortController | null = null;
  private dispatching = false;

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
    if (this.abortController) {
      return;
    }

    this.abortController = new AbortController();

    void this.runLoop();

    this.logger.log(
      `Dispatcher started (interval=${this.config.backpressure.dispatchIntervalMs}ms)`,
    );
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.logger.log('Dispatcher stopped');
  }

  isRunning(): boolean {
    return this.abortController !== null;
  }

  getStats(): {
    totalMoved: number;
    totalCycles: number;
    totalSkipped: number;
  } {
    return { ...this.stats };
  }

  async dispatchOnce(): Promise<number> {
    return this.dispatch();
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController?.signal;

    while (!signal?.aborted) {
      await this.dispatch();

      try {
        await setTimeout(
          this.config.backpressure.dispatchIntervalMs,
          undefined,
          {
            signal,
          },
        );
      } catch {
        break;
      }
    }
  }

  private async dispatch(): Promise<number> {
    if (this.dispatching) {
      return 0;
    }
    this.dispatching = true;

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
      this.dispatching = false;
    }
  }

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

### Worker Pool Service (오케스트레이터)

**`worker-pool/WorkerPoolService.ts`**

```typescript
import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { Worker } from './Worker';
import { WorkerState } from '../model/WorkerState';
import { FetcherService } from './FetcherService';
import { DispatcherService } from '../backpressure/DispatcherService';
import {
  JobProcessor,
  JOB_PROCESSOR,
} from '../model/job-processor/JobProcessor';
import { FairQueueService } from '../fair-queue/FairQueueService';
import { BackpressureService } from '../backpressure/BackpressureService';
import { ReadyQueueService } from '../backpressure/ReadyQueueService';
import { CongestionControlService } from '../congestion/CongestionControlService';
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';

@Injectable()
export class WorkerPoolService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerPoolService.name);
  private readonly workers: Worker[] = [];
  private readonly processorMap = new Map<string, JobProcessor>();
  private isShuttingDown = false;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    @Inject(JOB_PROCESSOR) processors: JobProcessor[],
    private readonly fetcherService: FetcherService,
    private readonly dispatcherService: DispatcherService,
    private readonly fairQueue: FairQueueService,
    private readonly backpressure: BackpressureService,
    private readonly readyQueue: ReadyQueueService,
    private readonly congestionControl: CongestionControlService,
  ) {
    for (const processor of processors) {
      this.processorMap.set(processor.type, processor);
      this.logger.log(`Registered processor: ${processor.type}`);
    }
  }

  async onModuleInit(): Promise<void> {
    this.createWorkers();
    this.startAll();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown signal received: ${signal}`);
    await this.shutdown();
  }

  getPoolStatus(): WorkerPoolStatus {
    const workerStates = this.workers.map((w) => ({
      id: w.id,
      state: w.getState(),
      currentJob: w.getCurrentJob()?.id ?? null,
    }));

    return {
      workerCount: this.workers.length,
      activeWorkers: workerStates.filter((w) => w.state === WorkerState.RUNNING)
        .length,
      idleWorkers: workerStates.filter(
        (w) => w.state === WorkerState.RUNNING && !w.currentJob,
      ).length,
      fetcherRunning: this.fetcherService.isRunning(),
      dispatcherRunning: this.dispatcherService.isRunning(),
      fetcherStats: this.fetcherService.getStats(),
      dispatcherStats: this.dispatcherService.getStats(),
      workers: workerStates,
      isShuttingDown: this.isShuttingDown,
    };
  }

  private createWorkers(): void {
    const { workerCount, workerTimeoutSec, jobTimeoutMs } =
      this.config.workerPool;

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(i, this.readyQueue, this.processorMap, {
        timeoutSec: workerTimeoutSec,
        jobTimeoutMs,
        onJobComplete: async (result) => this.handleJobComplete(result),
        onJobFailed: async (job, error) => this.handleJobFailed(job, error),
        loadJobData: async (jobId) =>
          this.redisService.hash.getAll(this.keys.job(jobId)),
      });
      this.workers.push(worker);
    }

    this.logger.log(`Created ${workerCount} workers`);
  }

  private startAll(): void {
    this.fetcherService.start();
    this.dispatcherService.start();

    for (const worker of this.workers) {
      worker.start();
    }

    this.logger.log('Worker Pool started: Fetcher + Dispatcher + Workers');
  }

  /**
   * 작업 완료 콜백.
   * Fair Queue ACK → 그룹 완료 확인 순으로 처리한다.
   *
   * Step 5 Aggregator 연동 시 recordJobResult() / finalizeGroup() 호출을 추가한다.
   * (현재 미구현)
   */
  private async handleJobComplete(result: JobProcessorResponse): Promise<void> {
    try {
      const isGroupCompleted = await this.fairQueue.ack(
        result.jobId,
        result.groupId,
      );

      if (isGroupCompleted) {
        this.logger.log(`Group ${result.groupId} completed`);
        await this.congestionControl.resetGroupStats(result.groupId);
      }

      this.logger.debug(
        `Job ${result.jobId} completed (success=${result.success}, ` +
          `duration=${result.durationMs}ms)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle job completion for ${result.jobId}: ${
          (error as Error).message
        }`,
        (error as Error).stack,
      );
    }
  }

  /**
   * 작업 실패 콜백.
   * 재시도 가능하면 Non-ready Queue로, 아니면 Dead Letter 처리.
   */
  private async handleJobFailed(job: Job, error: Error): Promise<void> {
    try {
      if (job.retryCount < this.config.workerPool.maxRetryCount) {
        const newRetryCount = await this.redisService.hash.incrementBy(
          this.keys.job(job.id),
          'retryCount',
          1,
        );

        await this.backpressure.requeue(job.id, job.groupId);
        this.logger.warn(
          `Job ${job.id} failed, requeueing (retry ${newRetryCount}/${this.config.workerPool.maxRetryCount}): ${error.message}`,
        );
      } else {
        await this.handleDeadLetter(job, error);
      }
    } catch (requeueError) {
      this.logger.error(
        `Failed to requeue job ${job.id}: ${(requeueError as Error).message}`,
        (requeueError as Error).stack,
      );
    }
  }

  /**
   * 최대 재시도를 초과한 작업을 Dead Letter Queue로 이동한다.
   *
   * Step 5 Aggregator 연동 시 Dead Letter 작업도 실패 결과로 집계해야 한다.
   * (현재 미구현)
   */
  private async handleDeadLetter(job: Job, error: Error): Promise<void> {
    const entry = JSON.stringify({
      job,
      error: error.message,
      failedAt: Date.now(),
      retryCount: job.retryCount,
    });
    await this.redisService.list.append(this.keys.deadLetterQueue(), entry);

    await this.fairQueue.ack(job.id, job.groupId);

    this.logger.error(
      `Job ${job.id} moved to Dead Letter Queue after ${job.retryCount} retries: ${error.message}`,
    );
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    this.logger.log('Starting graceful shutdown...');

    // 1. Fetcher 정지 (새 작업 유입 차단)
    this.fetcherService.stop();
    this.logger.log('Fetcher stopped');

    // 2. Worker에 정지 신호 전달 (현재 작업 완료 대기)
    const stopPromises = this.workers.map(async (w) => w.stop());

    // 3. 제한시간 내 Worker 종료 대기
    const gracePeriod = this.config.workerPool.shutdownGracePeriodMs;
    let graceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      graceTimeoutHandle = setTimeout(() => {
        this.logger.warn(`Shutdown grace period (${gracePeriod}ms) exceeded`);
        resolve();
      }, gracePeriod);
    });

    await Promise.race([Promise.all(stopPromises), timeoutPromise]);

    if (graceTimeoutHandle !== null) {
      clearTimeout(graceTimeoutHandle);
    }

    // 4. Dispatcher 정지
    this.dispatcherService.stop();
    this.logger.log('Dispatcher stopped');

    // 5. 최종 상태 로깅
    const stillRunning = this.workers.filter(
      (w) => w.getState() === WorkerState.RUNNING,
    );

    if (stillRunning.length > 0) {
      this.logger.warn(
        `${stillRunning.length} workers did not stop gracefully`,
      );
    } else {
      this.logger.log('All workers stopped gracefully');
    }

    this.logger.log('Graceful shutdown complete');
  }
}

export interface WorkerPoolStatus {
  workerCount: number;
  activeWorkers: number;
  idleWorkers: number;
  fetcherRunning: boolean;
  dispatcherRunning: boolean;
  fetcherStats: Record<string, number>;
  dispatcherStats: Record<string, number>;
  workers: Array<{
    id: number;
    state: WorkerState;
    currentJob: string | null;
  }>;
  isShuttingDown: boolean;
}
```

### 모듈 등록

**`BulkActionModule.ts`** (Step 3에서 확장)

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
import { BulkActionService } from './BulkActionService';
import { EmailProcessor } from './processor/EmailProcessor';
import { PushNotificationProcessor } from './processor/PushNotificationProcessor';
import { FetcherService } from './worker-pool/FetcherService';
import { JOB_PROCESSOR } from './model/job-processor/JobProcessor';
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
      fairQueue: {
        ...DEFAULT_FAIR_QUEUE_CONFIG,
        ...config.fairQueue,
      },
      backpressure: {
        ...DEFAULT_BACKPRESSURE_CONFIG,
        ...config.backpressure,
      },
      congestion: {
        ...DEFAULT_CONGESTION_CONFIG,
        ...config.congestion,
      },
      workerPool: {
        ...DEFAULT_WORKER_POOL_CONFIG,
        ...config.workerPool,
      },
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
        {
          provide: BULK_ACTION_CONFIG,
          useValue: mergedConfig,
        },
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
        FetcherService,
        WorkerPoolService,
        BulkActionService,
        EmailProcessor,
        PushNotificationProcessor,
        {
          provide: JOB_PROCESSOR,
          useFactory: (
            email: EmailProcessor,
            push: PushNotificationProcessor,
          ) => [email, push],
          inject: [EmailProcessor, PushNotificationProcessor],
        },
      ],
      exports: [
        BulkActionService,
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        CongestionControlService,
        WorkerPoolService,
      ],
    };
  }

  static registerProcessors(processors: any[]): DynamicModule {
    return {
      module: BulkActionModule,
      providers: [
        {
          provide: JOB_PROCESSOR,
          useFactory: (...instances: any[]) => instances,
          inject: processors,
        },
        ...processors,
      ],
      exports: [JOB_PROCESSOR],
    };
  }
}
```

### 사용 예시: JobProcessor 구현

현재 `libs/bulk-action/src/processor/`에 두 개의 프로세서가 내장되어 있다.

**`processor/EmailProcessor.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { JobProcessor } from '../model/job-processor/JobProcessor';

@Injectable()
export class EmailProcessor implements JobProcessor {
  readonly type = 'SEND_EMAIL';

  private readonly logger = new Logger(EmailProcessor.name);

  async process(job: Job): Promise<JobProcessorResponse> {
    const payload = JSON.parse(job.payload) as {
      to: string;
      subject: string;
      body: string;
    };

    this.logger.debug(`Sending email to ${payload.to}: "${payload.subject}"`);

    // TODO: 실제 이메일 발송 로직 (SES, SMTP 등)

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      data: { to: payload.to, subject: payload.subject },
      durationMs: 0,
    };
  }
}
```

**`processor/PushNotificationProcessor.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { JobProcessor } from '../model/job-processor/JobProcessor';

@Injectable()
export class PushNotificationProcessor implements JobProcessor {
  readonly type = 'PUSH_NOTIFICATION';

  private readonly logger = new Logger(PushNotificationProcessor.name);

  async process(job: Job): Promise<JobProcessorResponse> {
    const payload = JSON.parse(job.payload) as {
      deviceToken: string;
      title: string;
      message: string;
    };

    this.logger.debug(
      `Sending push to ${payload.deviceToken}: "${payload.title}"`,
    );

    // TODO: 실제 푸시 발송 로직 (FCM, APNs 등)

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      data: { deviceToken: payload.deviceToken, title: payload.title },
      durationMs: 0,
    };
  }
}
```

**모듈 등록 시 `register()` 내부에서 프로세서가 자동 등록된다:**

```typescript
// BulkActionModule.register() 내부에서 이미 EmailProcessor, PushNotificationProcessor를
// providers에 등록하고, useFactory로 JOB_PROCESSOR 토큰에 주입한다.
// 추가 프로세서가 필요하면 registerProcessors()로 별도 등록할 수 있다.

@Module({
  imports: [
    BulkActionModule.register({
      redis: { host: 'localhost', port: 6379 },
      workerPool: {
        workerCount: 20,
        fetchBatchSize: 100,
        jobTimeoutMs: 60000,
        maxRetryCount: 3,
      },
    }),
    // 추가 프로세서가 있을 경우:
    // BulkActionModule.registerProcessors([CustomProcessor]),
  ],
})
export class ApiModule {}
```

---

## Step 1~3과의 연동

### 전체 데이터 흐름

```
┌──────────────────────────────────────────────────────────────────┐
│                           Worker Pool                            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ Fetcher                                                  │     │
│  │                                                          │     │
│  │  fairQueue.dequeue()  ─── Step 1: 우선순위 기반 작업 선택  │     │
│  │         │                                                │     │
│  │         ▼                                                │     │
│  │  backpressure.admit() ─── Step 2: Rate Limit 검사        │     │
│  │         │                                                │     │
│  │    ┌────┴─────┐                                          │     │
│  │ allowed    denied                                        │     │
│  │    │          │                                          │     │
│  │    ▼          ▼                                          │     │
│  │ Ready Q   congestion    ── Step 3: 동적 backoff 계산     │     │
│  │           .addToNonReady()                               │     │
│  │              │                                           │     │
│  │              ▼                                           │     │
│  │          Non-ready Q                                     │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │ Dispatcher        │                                            │
│  │                   │                                            │
│  │ Non-ready Q ─────▶ Ready Q  (backoff 만료 작업 이동)           │
│  └──────────────────┘                                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Worker ×N                                                 │    │
│  │                                                           │    │
│  │  readyQueue.blockingPop()                                 │    │
│  │         │                                                 │    │
│  │         ▼                                                 │    │
│  │  jobProcessor.process(job)                                │    │
│  │         │                                                 │    │
│  │    ┌────┴──────┐                                          │    │
│  │  성공        실패                                          │    │
│  │    │           │                                          │    │
│  │    ▼           ▼                                          │    │
│  │  fairQueue  retry < max?                                  │    │
│  │   .ack()     ├── yes → backpressure.requeue() → Non-ready │    │
│  │    │         └── no  → Dead Letter Queue                  │    │
│  │    │                                                      │    │
│  │    ├── isGroupCompleted?                                  │    │
│  │    │   └── yes → congestion.resetGroupStats()             │    │
│  │    │            → rateLimiter.deactivateGroup()           │    │
│  │    │                                                      │    │
│  │    └── Step 5 (미구현): aggregator.recordJobResult()       │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 시퀀스 다이어그램: 작업 1건의 전체 생애주기

```
Client          Fetcher          RateLimiter       ReadyQueue       Worker          FairQueue
  │                │                 │                │               │                │
  │  enqueue()     │                 │                │               │                │
  │───────────────────────────────────────────────────────────────────────────────────▶│
  │                │                 │                │               │                │
  │                │  dequeue()      │                │               │                │
  │                │─────────────────────────────────────────────────────────────────▶│
  │                │◀────────────────────────────────────────────────────────────────│
  │                │  job            │                │               │                │
  │                │                 │                │               │                │
  │                │  checkRate()    │                │               │                │
  │                │────────────────▶│                │               │                │
  │                │◀────────────────│                │               │                │
  │                │  allowed        │                │               │                │
  │                │                 │                │               │                │
  │                │  push(jobId)    │                │               │                │
  │                │─────────────────────────────────▶│               │                │
  │                │                 │                │               │                │
  │                │                 │                │  BLPOP        │                │
  │                │                 │                │◀──────────────│                │
  │                │                 │                │  jobId        │                │
  │                │                 │                │──────────────▶│                │
  │                │                 │                │               │                │
  │                │                 │                │               │  process(job)  │
  │                │                 │                │               │───────┐        │
  │                │                 │                │               │       │        │
  │                │                 │                │               │◀──────┘        │
  │                │                 │                │               │  result        │
  │                │                 │                │               │                │
  │                │                 │                │               │  ack()         │
  │                │                 │                │               │───────────────▶│
  │                │                 │                │               │                │
```

---

## Graceful Shutdown

### 종료 순서

애플리케이션이 SIGTERM/SIGINT를 수신하면 다음 순서로 종료한다.

```
SIGTERM 수신
     │
     ▼
1. Fetcher 정지
   └─ 새 작업 유입 차단
   └─ Fair Queue에서 더 이상 dequeue하지 않음
     │
     ▼
2. Worker 정지 신호 전달
   └─ 각 Worker는 현재 실행 중인 작업 완료 후 종료
   └─ BLPOP timeout으로 유휴 Worker는 빠르게 종료
     │
     ▼
3. Grace Period 대기 (default: 30초)
   └─ 모든 Worker 종료 대기
   └─ 타임아웃 시 강제 종료
     │
     ▼
4. Dispatcher 정지
   └─ Non-ready → Ready 이동 중단
     │
     ▼
5. Redis 연결 정리
   └─ Ready Queue에 남은 작업은 다음 인스턴스가 처리
   └─ Non-ready Queue에 남은 작업도 보존됨
```

### NestJS Lifecycle Hook 활용

```typescript
// NestJS의 OnApplicationShutdown이 SIGTERM을 자동 처리

// main.ts에서 enableShutdownHooks 호출 필요
async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  app.enableShutdownHooks(); // SIGTERM, SIGINT 감지 활성화
  await app.listen(3000);
}
```

### 미처리 작업 보존

Graceful Shutdown 시 Ready Queue와 Non-ready Queue에 남은 작업은 Redis에 그대로 보존된다. 새 인스턴스가 시작되면 기존 작업을 이어서 처리한다.

```
인스턴스 A 종료 시 상태:
  Ready Queue:     [job-101, job-102, job-103]
  Non-ready Queue: [job-050 (backoff 3s), job-051 (backoff 5s)]

인스턴스 B 시작:
  → Worker가 Ready Queue의 job-101부터 처리 재개
  → Dispatcher가 Non-ready Queue의 backoff 만료 작업 이동 재개
  → Fetcher가 Fair Queue에서 새 작업 fetch 재개
```

단, **In-flight 작업**(Worker가 가져갔지만 ACK 전인 작업)은 유실될 수 있다. 이 문제는 Step 6(Reliable Queue + ACK)에서 해결한다.

---

## 테스트 전략

### Worker 단위 테스트

```typescript
import { setTimeout } from 'timers/promises';
import { Worker } from '@app/bulk-action/worker-pool/Worker';
import { WorkerState } from '@app/bulk-action/model/WorkerState';
import { JobProcessor } from '@app/bulk-action/model/job-processor/JobProcessor';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';

async function sleep(ms: number): Promise<void> {
  await setTimeout(ms);
}

/**
 * 실제 BLPOP처럼 지연 후 null을 반환하는 mock.
 * 즉시 null을 반환하면 Worker 루프가 tight spin → OOM 발생.
 */
function blockingNull(delayMs = 100): () => Promise<string | null> {
  return async () => {
    await setTimeout(delayMs);

    return null;
  };
}

describe('Worker', () => {
  let worker: Worker;
  let mockReadyQueue: jest.Mocked<ReadyQueueService>;
  let mockProcessor: jest.Mocked<JobProcessor>;
  let onJobComplete: jest.Mock;
  let onJobFailed: jest.Mock;
  let loadJobData: jest.Mock;

  beforeEach(() => {
    mockReadyQueue = {
      blockingPop: jest.fn(),
    } as any;

    mockProcessor = {
      type: 'TEST',
      process: jest.fn(),
    };

    onJobComplete = jest.fn().mockResolvedValue(undefined);
    onJobFailed = jest.fn().mockResolvedValue(undefined);
    loadJobData = jest.fn().mockResolvedValue({
      id: 'job-001',
      groupId: 'customer-A',
      processorType: 'TEST',
      payload: '{}',
      status: 'PROCESSING',
      retryCount: '0',
      createdAt: '0',
    });

    const processorMap = new Map([['TEST', mockProcessor]]);

    worker = new Worker(0, mockReadyQueue, processorMap, {
      timeoutSec: 1,
      jobTimeoutMs: 5000,
      onJobComplete,
      onJobFailed,
      loadJobData,
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('Ready Queue에서 작업을 꺼내 프로세서로 실행한다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: true,
      durationMs: 50,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockProcessor.process).toHaveBeenCalledTimes(1);
    expect(onJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-001', success: true }),
    );
  });

  it('프로세서가 실패하면 onJobFailed 콜백을 호출한다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockRejectedValue(new Error('API timeout'));

    // when
    worker.start();
    await sleep(300);

    // then
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.any(Error),
    );
  });

  it('작업이 jobTimeoutMs를 초과하면 타임아웃 오류를 발생시킨다', async () => {
    // given
    worker = new Worker(0, mockReadyQueue, new Map([['TEST', mockProcessor]]), {
      timeoutSec: 1,
      jobTimeoutMs: 500,
      onJobComplete,
      onJobFailed,
      loadJobData,
    });

    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockImplementation(async () => setTimeout(5000));

    // when
    worker.start();
    await sleep(1000);

    // then
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('timed out'),
      }),
    );
  }, 5000);

  it('stop() 호출 시 현재 작업 완료 후 종료한다', async () => {
    // given
    let resolveProcess!: (value: JobProcessorResponse) => void;
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        }),
    );

    // when
    worker.start();
    await sleep(100);

    expect(worker.getState()).toBe(WorkerState.RUNNING);

    const stopPromise = worker.stop();

    // then - Worker는 STOPPING 상태
    expect(worker.getState()).toBe(WorkerState.STOPPING);

    // 작업 완료
    resolveProcess({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: true,
      durationMs: 0,
    });

    await stopPromise;
    expect(worker.getState()).toBe(WorkerState.STOPPED);
  });
});
```

### Fetcher 통합 테스트

```typescript
import { setTimeout } from 'timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisService } from '@app/redis/RedisService';
import { FairQueueService } from '@app/bulk-action/fair-queue/FairQueueService';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { FetcherService } from '@app/bulk-action/worker-pool/FetcherService';
import { BulkActionModule } from '@app/bulk-action/BulkActionModule';
import { WorkerPoolService } from '@app/bulk-action/worker-pool/WorkerPoolService';

describe('FetcherService (Integration)', () => {
  let module: TestingModule;
  let fetcher: FetcherService;
  let fairQueue: FairQueueService;
  let readyQueue: ReadyQueueService;
  let redisService: RedisService;

  const env = Configuration.getEnv();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: {
            host: env.redis.host,
            port: env.redis.port,
            password: env.redis.password,
            db: env.redis.db,
            keyPrefix: 'test-fetcher:',
          },
          backpressure: { globalRps: 100, readyQueueMaxSize: 10 },
          workerPool: {
            fetchIntervalMs: 50,
            fetchBatchSize: 5,
            workerCount: 0,
            workerTimeoutSec: 1,
          },
        }),
      ],
    }).compile();

    fetcher = module.get(FetcherService);
    fairQueue = module.get(FairQueueService);
    readyQueue = module.get(ReadyQueueService);
    redisService = module.get(RedisService);

    await module.init();
  });

  beforeEach(async () => {
    fetcher.stop();
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    fetcher.stop();
    await module.get(WorkerPoolService).onApplicationShutdown('test-cleanup');
    await module.close();
  });

  it('Fair Queue에서 작업을 꺼내 Ready Queue로 전달한다', async () => {
    // given
    for (let i = 0; i < 5; i++) {
      await fairQueue.enqueue({
        groupId: 'customer-A',
        jobId: `job-${i}`,
        jobProcessorType: 'TEST',
        payload: {},
      });
    }

    // when
    fetcher.start();
    await setTimeout(300);

    // then
    const readySize = await readyQueue.size();
    expect(readySize).toBeGreaterThan(0);
    expect(readySize).toBeLessThanOrEqual(5);
  });

  it('Ready Queue가 가득 차면 fetch를 중단한다', async () => {
    // given — 20개 작업 등록 (readyQueueMaxSize=10)
    for (let i = 0; i < 20; i++) {
      await fairQueue.enqueue({
        groupId: 'customer-A',
        jobId: `job-${i}`,
        jobProcessorType: 'TEST',
        payload: {},
      });
    }

    // when
    fetcher.start();
    await setTimeout(500);

    // then
    const readySize = await readyQueue.size();
    expect(readySize).toBeLessThanOrEqual(10);

    const stats = fetcher.getStats();
    expect(stats.totalFetched).toBeGreaterThan(0);
  });
});
```

### WorkerPool 통합 테스트

```typescript
import { setTimeout } from 'timers/promises';
import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisService } from '@app/redis/RedisService';
import { WorkerPoolService } from '@app/bulk-action/worker-pool/WorkerPoolService';
import { JobProcessor } from '@app/bulk-action/model/job-processor/JobProcessor';
import { Job } from '@app/bulk-action/model/job/Job';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';
import { BulkActionModule } from '@app/bulk-action/BulkActionModule';
import { WorkerState } from '@app/bulk-action/model/WorkerState';

@Injectable()
class SlowTestProcessor implements JobProcessor {
  readonly type = 'SLOW_TEST';

  async process(job: Job): Promise<JobProcessorResponse> {
    await setTimeout(2000);

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      durationMs: 2000,
    };
  }
}

describe('WorkerPoolService (Integration)', () => {
  let module: TestingModule;
  let pool: WorkerPoolService;
  let redisService: RedisService;

  const env = Configuration.getEnv();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: {
            host: env.redis.host,
            port: env.redis.port,
            password: env.redis.password,
            db: env.redis.db,
            keyPrefix: 'test-pool:',
          },
          workerPool: {
            workerCount: 3,
            workerTimeoutSec: 1,
            shutdownGracePeriodMs: 5000,
            fetchIntervalMs: 50,
          },
        }),
        BulkActionModule.registerProcessors([SlowTestProcessor]),
      ],
    }).compile();

    pool = module.get(WorkerPoolService);
    redisService = module.get(RedisService);

    await module.init();
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  it('Worker Pool이 초기화되면 Worker가 생성된다', () => {
    // when
    const status = pool.getPoolStatus();

    // then
    expect(status.workerCount).toBe(3);
    expect(status.isShuttingDown).toBe(false);
  });

  it('getPoolStatus()가 올바른 상태를 반환한다', () => {
    // when
    const status = pool.getPoolStatus();

    // then
    expect(status.workerCount).toBe(3);
    expect(status.workers).toHaveLength(3);
    expect(status.fetcherRunning).toBeDefined();
    expect(status.dispatcherRunning).toBeDefined();
    expect(status.fetcherStats).toBeDefined();
    expect(status.dispatcherStats).toBeDefined();
  });

  it('shutdown 시 isShuttingDown이 true가 된다', async () => {
    // when
    await pool.onApplicationShutdown('SIGTERM');

    // then
    const status = pool.getPoolStatus();
    expect(status.isShuttingDown).toBe(true);

    const stoppedWorkers = status.workers.filter(
      (w) => w.state === WorkerState.STOPPED,
    );
    expect(stoppedWorkers.length).toBe(3);
  });
});
```

---

## 운영 고려사항

### 모니터링 지표

```
# Worker Pool 상태
bulk_action_worker_pool_size                         # 총 Worker 수
bulk_action_worker_pool_active                       # 실행 중 Worker 수
bulk_action_worker_pool_idle                          # 유휴 Worker 수

# Fetcher 성능
bulk_action_fetcher_total_fetched                    # 총 fetch 수
bulk_action_fetcher_empty_polls                      # Fair Queue 빈 폴링 수
bulk_action_fetcher_admitted_ready                   # Ready Queue 진입 수
bulk_action_fetcher_admitted_non_ready               # Non-ready Queue 진입 수

# Dispatcher 성능
bulk_action_dispatcher_total_moved                   # 총 이동 수
bulk_action_dispatcher_total_skipped                 # Ready Queue 가득 차서 스킵 수

# Worker 성능
bulk_action_worker_job_duration_ms                   # 작업 실행 시간 (histogram)
bulk_action_worker_job_success_total                 # 성공 작업 수
bulk_action_worker_job_failed_total                  # 실패 작업 수
bulk_action_worker_job_timeout_total                 # 타임아웃 작업 수
bulk_action_worker_job_retry_total                   # 재시도 수
bulk_action_worker_dead_letter_total                 # Dead Letter 수
```

### Worker 수 동적 조정

Worker 수를 런타임에 변경하는 것도 가능하다:

```typescript
// WorkerPoolService에 추가
async scaleWorkers(newCount: number): Promise<void> {
  const current = this.workers.length;

  if (newCount > current) {
    // Scale up
    for (let i = current; i < newCount; i++) {
      const worker = new Worker(i, this.readyQueue, this.processorMap, this.workerOptions);
      worker.start();
      this.workers.push(worker);
    }
  } else if (newCount < current) {
    // Scale down: 초과 Worker를 graceful하게 종료
    const toRemove = this.workers.splice(newCount);
    await Promise.all(toRemove.map((w) => w.stop()));
  }

  this.logger.log(`Scaled workers: ${current} → ${newCount}`);
}
```

### 설정 튜닝 가이드

| 설정 | 기본값 | 조정 기준 |
|------|-------|----------|
| `workerCount` | 10 | I/O 바운드: RPS × 평균 응답시간(초). CPU 바운드: 코어 수 |
| `fetchIntervalMs` | 200 | 낮을수록 반응 빠르지만 Redis 부하 증가. 100~500ms 권장 |
| `fetchBatchSize` | 50 | 1회 사이클에 가져올 최대 작업 수. Worker 수의 2~5배 권장 |
| `workerTimeoutSec` | 5 | BLPOP timeout. 짧으면 CPU 사용 증가, 길면 종료 지연 |
| `jobTimeoutMs` | 30,000 | 외부 API timeout보다 약간 길게 설정 |
| `maxRetryCount` | 3 | 재시도 불가능한 오류가 많으면 낮추기. 일시적 오류가 많으면 높이기 |
| `shutdownGracePeriodMs` | 30,000 | K8s terminationGracePeriodSeconds와 맞추기 |

### 장애 시나리오 대응

| 시나리오 | 증상 | 대응 |
|---------|------|------|
| Worker 전원 유휴 | Ready Queue 비어있음 | Fetcher 상태 확인. Fair Queue에 작업 있는지 확인 |
| Worker 전원 바쁨 | Ready Queue 증가 | workerCount 증가 또는 jobTimeoutMs 확인 |
| Fetcher 정지 | Ready Queue 소진 후 Worker 유휴 | Fetcher 오류 로그 확인. Fair Queue 연결 상태 확인 |
| Dead Letter 급증 | maxRetryCount 초과 빈발 | 외부 API 상태 확인. 오류 유형별 분석 |
| OOM | Worker 메모리 급증 | 작업 payload 크기 확인. workerCount 감소 |
| Shutdown 타임아웃 | 종료가 gracePeriod 초과 | jobTimeoutMs 확인. 장시간 작업 식별 |

### 후속 Step 연동 인터페이스

Step 4는 Step 5(Aggregator/Watcher)와 Step 6(Reliable Queue)의 **호출 시작점**이 된다. 아래는 각 Step이 Step 4의 어떤 지점에 연결되는지를 정리한 것이다.

#### Step 5 Aggregator 연동

현재 Aggregator는 **미구현** 상태이다. Step 5 구현 시 WorkerPoolService에 `@Optional()` 주입으로 `AggregatorService`를 연동할 예정이다.

**연동 포인트 요약:**

| WorkerPoolService 메서드 | Step 5 호출 (예정) | 설명 |
|--------------------------|-------------------|------|
| `handleJobComplete()` | `aggregator.recordJobResult(result)` | 성공/비재시도 실패 결과 집계 |
| `handleJobComplete()` (그룹 완료) | `aggregator.finalizeGroup(groupId)` | 그룹 최종 결과 산출 트리거 |
| `handleDeadLetter()` | `aggregator.recordJobResult({...})` | Dead Letter 실패도 집계에 포함 |

#### Step 6 Reliable Queue 연동

Step 6은 Ready Queue의 `BLPOP` → `RPOPLPUSH`(In-flight Queue) 교체가 핵심이다. Step 4에서 교체가 필요한 지점은 다음과 같다.

```typescript
// Step 4 현재: Worker.tick() — BLPOP으로 작업 꺼냄
const jobId = await this.readyQueue.blockingPop(this.options.timeoutSec);

// Step 6 교체: RPOPLPUSH로 꺼내면서 In-flight Queue에 동시 등록
const jobId = await this.readyQueue.reliablePop(
  this.options.timeoutSec,
  this.workerId,  // In-flight Queue 소유자 식별
);
```

```typescript
// Step 4 현재: handleJobComplete() — Fair Queue ACK만 수행
await this.fairQueue.ack(result.jobId, result.groupId);

// Step 6 교체: In-flight Queue에서도 제거 (ACK 완료)
await this.fairQueue.ack(result.jobId, result.groupId);
await this.inFlightQueue.ack(result.jobId, this.workerId);
```

```typescript
// Step 6 추가: Graceful Shutdown에서 미완료 In-flight 작업 반환
private async shutdown(): Promise<void> {
  // ... 기존 Fetcher/Worker 정지 로직 ...

  // Step 6: 미완료 작업을 Ready Queue로 복원
  const unfinishedJobs = await this.inFlightQueue.recoverAll();
  if (unfinishedJobs.length > 0) {
    await this.readyQueue.pushAll(unfinishedJobs);
    this.logger.warn(`Returned ${unfinishedJobs.length} in-flight jobs to Ready Queue`);
  }
}
```

**Step 6 교체 지점 요약:**

| 위치 | Step 4 현재 | Step 6 교체 |
|------|-------------|-------------|
| `Worker.tick()` | `readyQueue.blockingPop()` | `readyQueue.reliablePop()` (RPOPLPUSH) |
| `handleJobComplete()` | `fairQueue.ack()` | + `inFlightQueue.ack()` |
| `handleJobFailed()` | `backpressure.requeue()` | + `inFlightQueue.ack()` |
| `handleDeadLetter()` | `fairQueue.ack()` | + `inFlightQueue.ack()` |
| `shutdown()` | Worker 정지 대기 | + `inFlightQueue.recoverAll()` |
| — (신규) | — | Orphan Recovery: 비정상 종료된 Worker의 In-flight 작업 복구 |

### 다음 단계

Step 4까지 구현되면 벌크액션의 **실행 엔진**이 완성된다. 하지만 아직 두 가지가 부족하다:

1. **결과 집계 (Step 5)**: Worker가 처리한 개별 결과를 모아 최종 결과를 산출
2. **실패 복구 (Step 6)**: Worker가 작업을 가져간 후 비정상 종료하면 작업이 유실됨

```
Step 1~4: 작업을 공정하게 분배하고, 속도를 제어하고, 병렬로 실행
Step 5:   실행 결과를 MapReduce로 집계
Step 6:   In-flight 작업의 유실을 방지 (At-least-once 보장)
```


### 문서 갱신 히스토리

#### 1. 2026-02-04
```
#: 1                                                                                                                       
이슈: Worker.loadJob() 미구현                                                                                              
수정 내용: options.loadJobData() 콜백으로 Redis HGETALL 수행하는 구현 추가                                                 
────────────────────────────────────────                                                                                   
#: 2                                                                                                                       
이슈: createTimeout() 타이머 미정리                                                                                        
수정 내용: executeWithTimeout()에서 finally 블록으로 clearTimeout() 호출                                                   
────────────────────────────────────────                                                                                   
#: 3                                                                                                                       
이슈: Dispatcher에서 congestion 카운트 미감소                                                                              
수정 내용: congestionControl.onJobsMovedToReady() 호출 추가, Step 3 Lua 확장과의 관계 설명                                 
────────────────────────────────────────                                                                                   
#: 4                                                                                                                       
이슈: handleJobFailed() retryCount 미갱신                                                                                  
수정 내용: redis.hincrby() 로 Redis Job Hash의 retryCount 증가 후 requeue                                                  
────────────────────────────────────────                                                                                   
#: 5                                                                                                                       
이슈: handleJobComplete() Step 5 미연동                                                                                    
수정 내용: aggregator.recordJobResult() 및 aggregator.finalizeGroup() 호출 추가                                            
────────────────────────────────────────                                                                                   
#: 6                                                                                                                       
이슈: handleDeadLetter() Step 5 미반영                                                                                     
수정 내용: Dead Letter 작업도 aggregator.recordJobResult() 로 실패 집계                                                    
────────────────────────────────────────                                                                                   
#: 7                                                                                                                       
이슈: JOB_PROCESSOR 토큰 DI 오류                                                                                           
수정 내용: register()에 빈 배열 기본값 등록, registerProcessors() 사용 주의사항 추가                                       
────────────────────────────────────────                                                                                   
#: 8
이슈: 후속 Step 연동 인터페이스 부재
수정 내용: Step 5 Aggregator 연동 포인트 3개, Step 6 교체 포인트 6개 명시
```

#### 2. 2026-02-10
```
#: 1
이슈: 파일명 kebab-case → PascalCase 불일치
수정 내용: 프로젝트 컨벤션에 맞게 모든 파일명을 PascalCase로 변경
────────────────────────────────────────
#: 2
이슈: REDIS_CLIENT 토큰이 프로젝트에 존재하지 않음
수정 내용: REDIS_CLIENT + raw ioredis → RedisService(@app/redis) 패턴으로 전환
────────────────────────────────────────
#: 3
이슈: BULK_ACTION_CONFIG import 경로 불일치
수정 내용: '../redis/redis.provider' → '../config/BulkActionConfig'로 수정
────────────────────────────────────────
#: 4
이슈: RedisKeyBuilder 미사용, 하드코딩된 키 문자열
수정 내용: RedisKeyBuilder 주입 패턴으로 전환, dead-letter-queue 키 추가 필요 표시
────────────────────────────────────────
#: 5
이슈: DEFAULT_BULK_ACTION_CONFIG 단일 객체가 존재하지 않음
수정 내용: 개별 defaults 패턴(DEFAULT_WORKER_POOL_CONFIG)으로 변경, register() 시그니처 실제 코드에 맞춤
────────────────────────────────────────
#: 6
이슈: BulkActionModule에서 redisProvider 사용 (존재하지 않음)
수정 내용: RedisModule.register() imports 패턴으로 교체, RedisKeyBuilder 등록 추가
────────────────────────────────────────
#: 7
이슈: Worker.loadJob() options에 loadJobData 타입 누락
수정 내용: options 타입에 loadJobData 콜백 추가, WorkerPoolService.createWorkers()에서 콜백 전달
────────────────────────────────────────
#: 8
이슈: CongestionControlService.onJobsMovedToReady() 메서드 부재
수정 내용: Dispatcher를 기존 backpressure/ 위치 유지하고 실제 코드(RedisService + RedisKeyBuilder + moveToReady Lua)에 맞춤
────────────────────────────────────────
#: 9
이슈: 중복 JSDoc 블록 (handleJobComplete, handleDeadLetter)
수정 내용: 중복 제거
────────────────────────────────────────
#: 10
이슈: error 변수 타입 미캐스팅 (no-floating-promises/strict)
수정 내용: catch 블록 내 error를 (error as Error)로 타입 캐스팅
────────────────────────────────────────
#: 11
이슈: setInterval 반환값 타입 불일치 + floating promise
수정 내용: @ts-ignore 주석 추가, void 키워드로 floating promise 방지
────────────────────────────────────────
#: 12
이슈: 테스트 코드에서 REDIS_CLIENT 토큰 사용
수정 내용: RedisService + flushDatabase() 패턴으로 교체
```

#### 3. 2026-02-20
```
#: 1
이슈: model 디렉토리 리팩터링 미반영 (flat → subdirectory)
수정 내용: model/Job.ts → model/job/Job.ts, model/JobProcessorResponse.ts → model/job-processor/dto/JobProcessorResponse.ts 등 전체 import 경로 갱신
────────────────────────────────────────
#: 2
이슈: Job.type 필드명이 Job.processorType으로 변경됨
수정 내용: Worker 코드, 테스트 코드 전체에서 type → processorType 갱신
────────────────────────────────────────
#: 3
이슈: WorkerState가 Worker.ts 내부 정의 → model/WorkerState.ts로 분리됨
수정 내용: import { Worker, WorkerState } from './Worker' → 별도 import으로 갱신
────────────────────────────────────────
#: 4
이슈: Fetcher/Dispatcher가 setInterval 기반 → AbortController 기반 async loop로 전환됨
수정 내용: FetcherState/DispatcherState enum 제거, AbortController + runLoop() + setTimeout from timers/promises 패턴 반영
────────────────────────────────────────
#: 5
이슈: Worker.executeWithTimeout()이 new Promise + clearTimeout → AbortController 패턴으로 전환됨
수정 내용: AbortController + timers/promises.setTimeout + ac.abort() 패턴 반영
────────────────────────────────────────
#: 6
이슈: Worker.loadJob()이 객체 리터럴 → new Job(data) 생성으로 변경됨
수정 내용: return { ... } → return new Job(data) 반영
────────────────────────────────────────
#: 7
이슈: WorkerPoolService에서 aggregator 코드가 현재 미구현 상태
수정 내용: aggregator 관련 코드 제거, 미구현 상태 주석으로 표시
────────────────────────────────────────
#: 8
이슈: backpressure.requeue() 호출 인자 3개 → 2개로 변경 (retryCount 제거)
수정 내용: requeue(job.id, job.groupId, newRetryCount) → requeue(job.id, job.groupId)
────────────────────────────────────────
#: 9
이슈: WorkerPoolStatus의 fetcherState/dispatcherState → fetcherRunning/dispatcherRunning으로 변경
수정 내용: string → boolean 타입으로 갱신, isRunning() 메서드 반영
────────────────────────────────────────
#: 10
이슈: list.pushTail() → list.append() 메서드명 변경
수정 내용: handleDeadLetter()에서 메서드명 갱신
────────────────────────────────────────
#: 11
이슈: shutdown()에서 grace timeout clearTimeout 누락 → 메모리 누수 방지 코드 추가됨
수정 내용: graceTimeoutHandle + clearTimeout 패턴 반영
────────────────────────────────────────
#: 12
이슈: BulkActionModule 프로세서 등록 방식 변경
수정 내용: useValue: [] → useFactory로 EmailProcessor/PushNotificationProcessor 직접 등록 반영, BulkActionService exports 추가
────────────────────────────────────────
#: 13
이슈: 사용 예시가 가상 PromotionProcessor → 실제 구현 프로세서로 변경
수정 내용: EmailProcessor, PushNotificationProcessor 실제 코드 기준으로 갱신
────────────────────────────────────────
#: 14
이슈: 테스트 코드가 실제 테스트 파일과 불일치 (import, mock 패턴, enqueue 필드명)
수정 내용: 실제 테스트 코드 기준으로 전면 갱신 (blockingNull 헬퍼, jobProcessorType, workerCount: 0 등)
────────────────────────────────────────
#: 15
이슈: 디렉토리 구조가 리팩터링 이전 상태
수정 내용: 실제 디렉토리 구조에 맞게 전면 갱신 (processor/, model 하위 디렉토리, BulkActionService.ts 등)
────────────────────────────────────────
#: 16
이슈: result.destination === 'ready' (문자열) → BackpressureDestination.READY (enum)
수정 내용: Fetcher 코드에서 enum import 및 비교 패턴 반영
────────────────────────────────────────
#: 17
이슈: requeueError.message 미캐스팅
수정 내용: (requeueError as Error).message로 타입 캐스팅 반영
────────────────────────────────────────
#: 18
이슈: JobProcessor 인터페이스 파일 위치 변경 (worker-pool/ → model/job-processor/)
수정 내용: import 경로 및 파일 헤더 위치 갱신
```
