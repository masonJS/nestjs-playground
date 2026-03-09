import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface DeadLetterEntry {
  jobId: string;
  groupId: string;
  retryCount: number;
  error: string;
  failedAt: number;
}

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async size(): Promise<number> {
    return this.redisService.list.length(this.keys.deadLetterQueue());
  }

  async list(offset: number, limit: number): Promise<DeadLetterEntry[]> {
    const raw = await this.redisService.list.range(
      this.keys.deadLetterQueue(),
      offset,
      offset + limit - 1,
    );

    return raw.map((entry) => JSON.parse(entry) as DeadLetterEntry);
  }

  async retry(jobId: string): Promise<boolean> {
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);

    for (let i = 0; i < entries.length; i++) {
      const entry = JSON.parse(entries[i]) as DeadLetterEntry;

      if (entry.jobId === jobId) {
        // retryCount 리셋
        await this.redisService.hash.set(
          this.keys.job(jobId),
          'retryCount',
          '0',
        );
        await this.redisService.hash.set(
          this.keys.job(jobId),
          'status',
          'PENDING',
        );

        // Ready Queue에 재투입
        await this.redisService.list.append(this.keys.readyQueue(), jobId);

        // DLQ에서 제거 (LREM)
        await this.removeFromDLQ(entries[i]);

        this.logger.log(`Retried DLQ job ${jobId}`);

        return true;
      }
    }

    return false;
  }

  async retryAll(): Promise<number> {
    const dlqKey = this.keys.deadLetterQueue();
    let count = 0;

    while (true) {
      const entry = await this.redisService.list.popHead(dlqKey);

      if (!entry) {
        break;
      }

      const parsed = JSON.parse(entry) as DeadLetterEntry;

      await this.redisService.hash.set(
        this.keys.job(parsed.jobId),
        'retryCount',
        '0',
      );
      await this.redisService.hash.set(
        this.keys.job(parsed.jobId),
        'status',
        'PENDING',
      );
      await this.redisService.list.append(this.keys.readyQueue(), parsed.jobId);

      count++;
    }

    this.logger.log(`Retried ${count} DLQ jobs`);

    return count;
  }

  async purge(jobId: string): Promise<boolean> {
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);

    for (const entry of entries) {
      const parsed = JSON.parse(entry) as DeadLetterEntry;

      if (parsed.jobId === jobId) {
        await this.removeFromDLQ(entry);

        return true;
      }
    }

    return false;
  }

  async cleanup(olderThanMs?: number): Promise<number> {
    const retention =
      olderThanMs ?? this.config.reliableQueue.deadLetterRetentionMs;
    const cutoff = Date.now() - retention;
    const dlqKey = this.keys.deadLetterQueue();
    const entries = await this.redisService.list.range(dlqKey, 0, -1);

    let removed = 0;

    for (const entry of entries) {
      const parsed = JSON.parse(entry) as DeadLetterEntry;

      if (parsed.failedAt < cutoff) {
        await this.removeFromDLQ(entry);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.log(`Cleaned up ${removed} expired DLQ entries`);
    }

    return removed;
  }

  private async removeFromDLQ(entryJson: string): Promise<void> {
    // LREM key count value — count=1이면 첫 번째 매칭 제거
    const dlqKey = this.keys.deadLetterQueue();
    // ioredis LREM은 RedisService에 없으므로 callCommand 사용 불가.
    // list.range + trim 패턴 대신 직접 삭제 마커 방식:
    // 값을 __DELETED__로 교체 후 LREM
    // 그러나 이는 복잡함. 대신 간단히 모든 엔트리를 읽고, 필터링 후 재작성
    // 실제로는 소량 DLQ이므로 성능 문제 없음
    const allEntries = await this.redisService.list.range(dlqKey, 0, -1);
    const filtered = allEntries.filter((e) => e !== entryJson);

    await this.redisService.delete(dlqKey);

    for (const entry of filtered) {
      await this.redisService.list.append(dlqKey, entry);
    }
  }
}
