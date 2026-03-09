import { setTimeout } from 'timers/promises';
import { Logger } from '@nestjs/common';
import { Job } from '../model/job/Job';
import { JobProcessor } from '../model/job-processor/JobProcessor';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { WorkerState } from '../model/WorkerState';
import { DequeueResult } from '../reliable-queue/DequeueResult';

export class Worker {
  private readonly logger: Logger;
  private state: WorkerState = WorkerState.IDLE;
  private currentJob: Job | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    readonly id: number,
    private readonly processorMap: Map<string, JobProcessor>,
    private readonly options: {
      jobTimeoutMs: number;
      pollIntervalMs: number;
      onJobComplete: (result: JobProcessorResponse) => Promise<void>;
      onJobFailed: (job: Job, error: Error) => Promise<void>;
      loadJobData: (jobId: string) => Promise<Record<string, string> | null>;
      reliableDequeue: (workerId: string) => Promise<DequeueResult | null>;
      reliableAck: (jobId: string) => Promise<boolean>;
      reliableNack: (jobId: string) => Promise<void>;
      extendDeadline: (jobId: string) => Promise<boolean>;
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
    const workerId = `worker-${this.id}`;
    const dequeueResult = await this.options.reliableDequeue(workerId);

    if (!dequeueResult) {
      await setTimeout(this.options.pollIntervalMs);

      return;
    }

    const { jobId } = dequeueResult;

    // 작업 데이터 로드
    const job = await this.loadJob(jobId);

    if (!job) {
      this.logger.warn(`Job ${jobId} not found, cleaning up in-flight entry`);
      await this.options.reliableAck(jobId);

      return;
    }

    this.currentJob = job;
    const startTime = Date.now();

    try {
      // 프로세서 선택
      const processor = this.processorMap.get(job.processorType);

      if (!processor) {
        throw new Error(
          `No processor registered for job type: ${job.processorType}`,
        );
      }

      // 타임아웃 + heartbeat 실행
      const result = await this.executeWithHeartbeat(processor, job, jobId);
      result.durationMs = Date.now() - startTime;
      result.processorType = job.processorType;

      // 결과 처리
      if (result.success) {
        await this.options.reliableAck(jobId);
        await this.options.onJobComplete(result);
      } else if (result.error?.retryable) {
        await this.options.reliableNack(jobId);
        await this.options.onJobFailed(job, new Error(result.error.message));
      } else {
        // 재시도 불가능한 오류 → 재시도 없이 완료 처리
        await this.options.reliableAck(jobId);
        await this.options.onJobComplete(result);
      }
    } catch (error) {
      this.logger.error(
        `Job ${jobId} failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.options.reliableNack(jobId);
      await this.options.onJobFailed(job, error as Error);
    } finally {
      this.currentJob = null;
    }
  }

  private async executeWithHeartbeat(
    processor: JobProcessor,
    job: Job,
    jobId: string,
  ): Promise<JobProcessorResponse> {
    const heartbeatIntervalMs = Math.floor(this.options.jobTimeoutMs * 0.6);
    const heartbeatHandle = setInterval(() => {
      void this.options.extendDeadline(jobId).catch((err) => {
        this.logger.warn(
          `Failed to extend deadline for job ${jobId}: ${
            (err as Error).message
          }`,
        );
      });
    }, heartbeatIntervalMs);

    try {
      return await this.executeWithTimeout(processor, job);
    } finally {
      clearInterval(heartbeatHandle);
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
