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
import { JobStatus } from '../model/job/type/JobStatus';
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

  private async handleJobFailed(job: Job, error: Error): Promise<void> {
    try {
      if (job.retryCount < this.config.workerPool.maxRetryCount) {
        const newRetryCount = await this.redisService.hash.incrementBy(
          this.keys.job(job.id),
          'retryCount',
          1,
        );

        await this.redisService.hash.set(
          this.keys.job(job.id),
          'status',
          JobStatus.PENDING,
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

  private async handleDeadLetter(job: Job, error: Error): Promise<void> {
    const entry = JSON.stringify({
      job,
      error: error.message,
      failedAt: Date.now(),
      retryCount: job.retryCount,
    });
    await this.redisService.list.append(this.keys.deadLetterQueue(), entry);

    await this.redisService.hash.set(
      this.keys.job(job.id),
      'status',
      JobStatus.FAILED,
    );
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
