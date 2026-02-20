import { RedisService } from '@app/redis/RedisService';
import { Injectable, Logger } from '@nestjs/common';
import { NonReadyQueueService } from './backpressure/NonReadyQueueService';
import { ReadyQueueService } from './backpressure/ReadyQueueService';
import { CongestionControlService } from './congestion/CongestionControlService';
import { FairQueueService } from './fair-queue/FairQueueService';
import { RedisKeyBuilder } from './key/RedisKeyBuilder';
import { BulkActionRequest } from './model/BulkActionRequest';
import { GroupProgress, SubmitBulkJobsRequest } from './model/GroupProgress';
import { Job } from './model/job/Job';
import { WorkerPoolService } from './worker-pool/WorkerPoolService';

@Injectable()
export class BulkActionService {
  private readonly logger = new Logger(BulkActionService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly keys: RedisKeyBuilder,
    private readonly fairQueue: FairQueueService,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
    private readonly congestionControl: CongestionControlService,
    private readonly workerPool: WorkerPoolService,
  ) {}

  // =========================================================================
  //  Bulk Action 전체 워크플로우
  //
  //  ┌──────────┐  submitJob()   ┌─────────────┐  fetchCycle()  ┌───────────┐
  //  │  Client  │ ──────────── → │  Fair Queue  │ ───────────→  │  Admit()  │
  //  └──────────┘  enqueue.lua   │  (SortedSet) │  dequeue.lua  └─────┬─────┘
  //                              └─────────────┘             ┌────────┴────────┐
  //                                                          │                 │
  //                                                    [rate-limit OK]   [rate-limit 초과]
  //                                                          │                 │
  //                                                          ▼                 ▼
  //                                                   Ready Queue       Non-ready Queue
  //                                                     (List)           (SortedSet)
  //                                                          │                 │
  //                                                          │     score ≤ now │
  //                                                          │   ◄─────────────┘
  //                                                          │   move-to-ready.lua
  //                                                          ▼   (DispatcherService)
  //                                                    ┌───────────┐
  //                                                    │  Worker   │ BLPOP 대기
  //                                                    └─────┬─────┘
  //                                               ┌──────────┼──────────┐
  //                                               │          │          │
  //                                          [성공]     [재시도 가능]  [maxRetry 초과]
  //                                          ack.lua   Non-ready로    Dead Letter
  //                                               │     재진입         Queue
  //                                               ▼
  //                                     doneJobs >= totalJobs?
  //                                          → 그룹 완료
  //
  // ─────────────────────────────────────────────────────────────────────────
  //
  //  Phase 1. 작업 등록 — submitJob() / submitBulkJobs()
  //
  //    enqueue.lua (원자적 Lua 스크립트)
  //    ┌─────────────────────────────────────────────────────────────────┐
  //    │  1. HSET  job:{jobId}                                         │
  //    │     → { id, groupId, processorType, payload, status=PENDING,  │
  //    │        retryCount=0, createdAt=now }                          │
  //    │                                                               │
  //    │  2. RPUSH group:{groupId}:jobs  jobId                         │
  //    │     → 그룹별 FIFO 작업 목록에 추가                               │
  //    │                                                               │
  //    │  3. HINCRBY group:{groupId}:meta totalJobs 1                  │
  //    │     → 첫 Job이면 meta 초기화 (status=CREATED, doneJobs=0)       │
  //    │                                                               │
  //    │  4. ZADD fair-queue:{level} score groupId                     │
  //    │     → level = high | normal | low                             │
  //    │     → score = (-nowMs) + basePriority + α×(-1+total/remain)   │
  //    │       · α (alpha, default 10000): SJF 부스트 계수              │
  //    │       · 잔여 작업이 적을수록 score↑ → 우선 소비 (SJF)            │
  //    └─────────────────────────────────────────────────────────────────┘
  //
  // ─────────────────────────────────────────────────────────────────────────
  //
  //  Phase 2. 작업 인출 + 배압 제어 — FetcherService (매 200ms)
  //
  //    fetchCycle() — 배치 최대 50건씩 인출
  //    ┌─────────────────────────────────────────────────────────────────┐
  //    │  2-1. Ready Queue 여유 확인                                     │
  //    │       → 가득 차면 (≥ readyQueueMaxSize) cycle 종료              │
  //    │                                                               │
  //    │  2-2. dequeue.lua (원자적)                                     │
  //    │       → HIGH → NORMAL → LOW 순으로 ZREVRANGE 탐색              │
  //    │       → 최고 score 그룹의 group:{gid}:jobs에서 LPOP            │
  //    │       → HSET job status=PROCESSING                            │
  //    │       → 그룹 score 재계산 후 ZADD 갱신 (잔여=0이면 ZREM)         │
  //    │                                                               │
  //    │  2-3. BackpressureService.admit(job)                          │
  //    │       ├─ rate-limit-check.lua                                 │
  //    │       │   · INCR global counter → globalRps 초과 시 reject     │
  //    │       │   · perGroupLimit = floor(globalRps / activeGroups)   │
  //    │       │   · INCR group counter → perGroupLimit 초과 시 reject  │
  //    │       │                                                       │
  //    │       ├─ [allowed] → ready-queue-push.lua                    │
  //    │       │   · LLEN < maxSize 확인 후 RPUSH ready-queue          │
  //    │       │                                                       │
  //    │       └─ [denied] → congestion-backoff.lua                   │
  //    │           · backoffMs = base + floor(nonReady/speed)×1000     │
  //    │           · ZADD non-ready-queue score=(now + backoffMs)      │
  //    │           · 혼잡도: NONE / LOW / MODERATE / HIGH / CRITICAL   │
  //    └─────────────────────────────────────────────────────────────────┘
  //
  // ─────────────────────────────────────────────────────────────────────────
  //
  //  Phase 3. 작업 실행 — Worker (workerCount, default 10)
  //
  //    각 Worker는 독립 루프로 실행
  //    ┌─────────────────────────────────────────────────────────────────┐
  //    │  3-1. BLPOP ready-queue (timeout 5s)                          │
  //    │       → timeout 시 재대기 (graceful stop 체크 포함)              │
  //    │                                                               │
  //    │  3-2. HGETALL job:{jobId} → Job 데이터 로드                    │
  //    │                                                               │
  //    │  3-3. processorMap[job.processorType].process(job) 실행        │
  //    │       → jobTimeoutMs (default 30s) 초과 시 타임아웃 에러         │
  //    │                                                               │
  //    │  3-4. 결과 분기                                                │
  //    │       ├─ 성공 (success=true)                                  │
  //    │       │   → ack.lua: HSET status=COMPLETED                   │
  //    │       │              HINCRBY group:meta doneJobs 1            │
  //    │       │              doneJobs ≥ totalJobs → status=AGGREGATING│
  //    │       │   → 그룹 완료 시 congestion stats 초기화               │
  //    │       │                                                       │
  //    │       ├─ 실패 (retryable=true, retryCount < maxRetryCount=3) │
  //    │       │   → HINCRBY job:{id} retryCount 1                    │
  //    │       │   → Non-ready Queue로 재진입 (backoff 적용)            │
  //    │       │   → Phase 4 Dispatcher가 Ready Queue로 복귀시킴        │
  //    │       │                                                       │
  //    │       └─ 실패 (retryable=false 또는 retryCount ≥ 3)           │
  //    │           → RPUSH dead-letter-queue jobId                     │
  //    │           → ack.lua 호출 (그룹 완료 판정 차단 방지)               │
  //    └─────────────────────────────────────────────────────────────────┘
  //
  // ─────────────────────────────────────────────────────────────────────────
  //
  //  Phase 4. Non-ready → Ready 승격 — DispatcherService (매 100ms)
  //
  //    move-to-ready.lua (원자적)
  //    ┌─────────────────────────────────────────────────────────────────┐
  //    │  1. ZRANGEBYSCORE non-ready-queue -inf {now} LIMIT 100        │
  //    │     → backoff 만료된(score ≤ now) 작업 최대 100건 선택          │
  //    │                                                               │
  //    │  2. 각 jobId에 대해:                                           │
  //    │     · ZREM non-ready-queue                                    │
  //    │     · RPUSH ready-queue                                       │
  //    │     · DECR congestion:{groupId}:non-ready-count               │
  //    │                                                               │
  //    │  3. Ready Queue에 적재 → Phase 3 Worker가 소비                 │
  //    └─────────────────────────────────────────────────────────────────┘
  //
  // ─────────────────────────────────────────────────────────────────────────
  //
  //  Redis Key 맵
  //    job:{jobId}                         — Job Hash (상태·페이로드)
  //    group:{groupId}:jobs                — 그룹 FIFO 작업 목록 (List)
  //    group:{groupId}:meta                — 그룹 메타 (totalJobs, doneJobs, status)
  //    fair-queue:{high|normal|low}        — 우선순위별 그룹 큐 (SortedSet)
  //    ready-queue                         — 실행 대기 큐 (List, BLPOP 소비)
  //    non-ready-queue                     — 배압/혼잡 대기 큐 (SortedSet, score=실행시각)
  //    rate-limit:{groupId}:{window}       — 그룹별 Rate Limit 카운터
  //    rate-limit:global:{window}          — 전역 Rate Limit 카운터
  //    active-groups                       — 활성 그룹 집합 (Set)
  //    congestion:{groupId}:non-ready-count — 그룹별 Non-ready 작업 수
  //    congestion:{groupId}:stats          — 혼잡 통계 (Hash)
  //    dead-letter-queue                   — 최종 실패 작업 (List)
  //
  // =========================================================================

  async submitJob(options: BulkActionRequest): Promise<void> {
    await this.fairQueue.enqueue(options);

    this.logger.debug(
      `Job submitted: ${options.jobId} (group=${options.jobGroupId}, processorType=${options.jobProcessorType})`,
    );
  }

  async submitBulkJobs(request: SubmitBulkJobsRequest): Promise<number> {
    const { groupId, processorType, jobs, basePriority, priorityLevel } =
      request;

    for (const job of jobs) {
      await this.fairQueue.enqueue({
        jobGroupId: groupId,
        jobId: job.jobId,
        jobProcessorType: processorType,
        payload: job.payload,
        basePriority,
        priorityLevel,
      });
    }

    this.logger.log(
      `Bulk submitted: ${jobs.length} jobs (group=${groupId}, processorType=${processorType})`,
    );

    return jobs.length;
  }

  // =========================================================================
  //  조회
  // =========================================================================

  async getJobStatus(jobId: string): Promise<Job | null> {
    const data = await this.redisService.hash.getAll(this.keys.job(jobId));

    if (!data || !data.id) {
      return null;
    }

    return new Job(data);
  }

  async getGroupProgress(groupId: string): Promise<GroupProgress> {
    const [meta, congestion, pendingInQueue] = await Promise.all([
      this.redisService.hash.getAll(this.keys.groupMeta(groupId)),
      this.congestionControl.getCongestionState(groupId),
      this.fairQueue.getGroupPendingCount(groupId),
    ]);

    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const doneJobs = parseInt(meta.doneJobs ?? '0', 10);

    return {
      groupId,
      totalJobs,
      doneJobs,
      pendingInQueue,
      progressPercent:
        totalJobs > 0 ? Math.floor((doneJobs / totalJobs) * 100) : 0,
      status: meta.status ?? 'UNKNOWN',
      congestion: {
        level: congestion.congestionLevel,
        nonReadyCount: congestion.nonReadyCount,
        lastBackoffMs: congestion.lastBackoffMs,
      },
    };
  }

  async getQueueDepths(): Promise<{
    fairQueue: { high: number; normal: number; low: number; total: number };
    readyQueue: number;
    nonReadyQueue: number;
    deadLetterQueue: number;
  }> {
    const [fairQueueStats, readySize, nonReadySize, dlqSize] =
      await Promise.all([
        this.fairQueue.getQueueStats(),
        this.readyQueue.size(),
        this.nonReadyQueue.size(),
        this.redisService.list.length(this.keys.deadLetterQueue()),
      ]);

    return {
      fairQueue: {
        high: fairQueueStats.highPriorityGroups,
        normal: fairQueueStats.normalPriorityGroups,
        low: fairQueueStats.lowPriorityGroups,
        total: fairQueueStats.totalGroups,
      },
      readyQueue: readySize,
      nonReadyQueue: nonReadySize,
      deadLetterQueue: dlqSize,
    };
  }

  getPoolStatus() {
    return this.workerPool.getPoolStatus();
  }
}
