import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export enum NonReadyReason {
  RATE_LIMITED = 'RATE_LIMITED',
  API_THROTTLED = 'API_THROTTLED',
  TRANSIENT_ERROR = 'TRANSIENT_ERROR',
}

@Injectable()
export class NonReadyQueueService {
  private readonly logger = new Logger(NonReadyQueueService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async push(
    jobId: string,
    backoffMs: number,
    reason: NonReadyReason,
  ): Promise<void> {
    const clampedBackoff = Math.min(
      backoffMs,
      this.config.backpressure.maxBackoffMs,
    );
    const executeAt = Date.now() + clampedBackoff;

    await this.redisService.sortedSet.add(
      this.keys.nonReadyQueue(),
      executeAt,
      jobId,
    );

    this.logger.debug(
      `Job ${jobId} -> Non-ready Queue (reason=${reason}, backoff=${clampedBackoff}ms)`,
    );
  }

  async pushWithExponentialBackoff(
    jobId: string,
    retryCount: number,
    reason: NonReadyReason,
  ): Promise<void> {
    const { defaultBackoffMs, maxBackoffMs } = this.config.backpressure;
    const backoff = Math.min(
      defaultBackoffMs * Math.pow(2, retryCount),
      maxBackoffMs,
    );
    await this.push(jobId, backoff, reason);
  }

  async peekReady(limit: number): Promise<string[]> {
    const now = Date.now().toString();

    return this.redisService.sortedSet.rangeByScore(
      this.keys.nonReadyQueue(),
      '-inf',
      now,
      0,
      limit,
    );
  }

  async popReady(limit: number): Promise<string[]> {
    const now = Date.now().toString();
    const jobs = await this.redisService.sortedSet.rangeByScore(
      this.keys.nonReadyQueue(),
      '-inf',
      now,
      0,
      limit,
    );

    if (jobs.length > 0) {
      await this.redisService.sortedSet.remove(
        this.keys.nonReadyQueue(),
        ...jobs,
      );
    }

    return jobs;
  }

  async remove(jobId: string): Promise<void> {
    await this.redisService.sortedSet.remove(this.keys.nonReadyQueue(), jobId);
  }

  async size(): Promise<number> {
    return this.redisService.sortedSet.count(this.keys.nonReadyQueue());
  }
}
