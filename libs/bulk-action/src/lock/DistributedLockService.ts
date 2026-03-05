import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {}

  async acquire(lockKey: string): Promise<string | null> {
    const token = randomUUID();
    const { lockTtlMs, lockRetryCount, lockRetryDelayMs } = this.config.watcher;

    for (let attempt = 0; attempt <= lockRetryCount; attempt++) {
      const result = await this.redisService.callCommand(
        'acquireLock',
        [lockKey],
        [token, lockTtlMs.toString()],
      );

      if (result === 1) {
        return token;
      }

      if (attempt < lockRetryCount) {
        await this.sleep(lockRetryDelayMs);
      }
    }

    this.logger.debug(`Failed to acquire lock: ${lockKey}`);

    return null;
  }

  async release(lockKey: string, token: string): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'releaseLock',
      [lockKey],
      [token],
    );

    return result === 1;
  }

  async withLock<T>(
    lockKey: string,
    callback: () => Promise<T>,
  ): Promise<T | null> {
    const token = await this.acquire(lockKey);

    if (!token) {
      return null;
    }

    try {
      return await callback();
    } finally {
      const released = await this.release(lockKey, token);

      if (!released) {
        this.logger.warn(`Failed to release lock: ${lockKey} (token expired?)`);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
