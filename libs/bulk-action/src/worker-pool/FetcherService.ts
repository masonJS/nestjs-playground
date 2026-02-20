import { setTimeout } from 'timers/promises';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { FairQueueService } from '../fair-queue/FairQueueService';
import {
  BackpressureDestination,
  BackpressureService,
} from '../backpressure/BackpressureService';
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
