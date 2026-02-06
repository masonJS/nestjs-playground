import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

@Injectable()
export class ReadyQueueService {
  private readonly logger = new Logger(ReadyQueueService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async push(jobId: string): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'readyQueuePush',
      [this.keys.readyQueue()],
      [jobId, this.config.backpressure.readyQueueMaxSize.toString()],
    );

    if (result === 0) {
      this.logger.warn(
        `Ready Queue full: maxSize=${this.config.backpressure.readyQueueMaxSize}`,
      );

      return false;
    }

    return true;
  }

  async pop(): Promise<string | null> {
    return this.redisService.list.popHead(this.keys.readyQueue());
  }

  async blockingPop(timeoutSec: number): Promise<string | null> {
    return this.redisService.list.blockingPopHead(
      this.keys.readyQueue(),
      timeoutSec,
    );
  }

  async size(): Promise<number> {
    return this.redisService.list.length(this.keys.readyQueue());
  }

  async hasCapacity(): Promise<boolean> {
    const currentSize = await this.redisService.list.length(
      this.keys.readyQueue(),
    );

    return currentSize < this.config.backpressure.readyQueueMaxSize;
  }
}
