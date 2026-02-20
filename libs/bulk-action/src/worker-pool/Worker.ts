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

  private async loadJob(jobId: string): Promise<Job | null> {
    const data = await this.options.loadJobData(jobId);

    if (!data || !data.id) {
      return null;
    }

    return new Job(data);
  }
}
