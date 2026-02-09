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
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

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
    if (this.intervalHandle) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.intervalHandle = setInterval(
      () => void this.dispatch(),
      this.config.backpressure.dispatchIntervalMs,
    );

    this.logger.log(
      `Dispatcher started (interval=${this.config.backpressure.dispatchIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Dispatcher stopped');
    }
  }

  async dispatchOnce(): Promise<number> {
    return this.dispatch();
  }

  private async dispatch(): Promise<number> {
    if (this.isRunning) {
      return 0;
    }
    this.isRunning = true;

    try {
      const hasCapacity = await this.readyQueue.hasCapacity();

      if (!hasCapacity) {
        this.logger.debug('Ready Queue full, skipping dispatch');

        return 0;
      }

      const moved = await this.moveToReady();

      if (moved > 0) {
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
      this.isRunning = false;
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
