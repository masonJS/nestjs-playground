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
