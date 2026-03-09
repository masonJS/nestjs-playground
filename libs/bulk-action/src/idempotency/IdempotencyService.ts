import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  /**
   * 원자적으로 처리 여부를 확인하고 마킹한다.
   * @returns true이면 이미 처리됨 (중복), false이면 미처리 (첫 실행)
   */
  async isProcessed(key: string): Promise<boolean> {
    const ttlSec = Math.ceil(this.config.reliableQueue.idempotencyTtlMs / 1000);
    const redisKey = this.keys.idempotency(key);
    const acquired = await this.redisService.string.setNX(
      redisKey,
      '1',
      ttlSec,
    );

    // setNX가 true(OK)이면 첫 실행 → isProcessed=false
    // setNX가 false이면 이미 존재 → isProcessed=true
    return !acquired;
  }

  async reset(key: string): Promise<void> {
    await this.redisService.delete(this.keys.idempotency(key));
  }

  async filterUnprocessed(keys: string[]): Promise<string[]> {
    const result: string[] = [];

    for (const key of keys) {
      const processed = await this.isProcessed(key);

      if (!processed) {
        result.push(key);
      }
    }

    return result;
  }
}
