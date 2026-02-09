import { Inject, Injectable } from '@nestjs/common';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { PriorityLevel } from '../model/JobGroup';

@Injectable()
export class RedisKeyBuilder {
  private readonly prefix: string;

  constructor(@Inject(BULK_ACTION_CONFIG) config: BulkActionConfig) {
    this.prefix = config.redis.keyPrefix ?? 'bulk-action:';
  }

  /** Lua 스크립트에 raw prefix를 전달할 때 사용 */
  getPrefix(): string {
    return this.prefix;
  }

  // ── Fair Queue ──

  fairQueue(level: PriorityLevel): string {
    return `${this.prefix}fair-queue:${level}`;
  }

  groupJobs(groupId: string): string {
    return `${this.prefix}group:${groupId}:jobs`;
  }

  groupMeta(groupId: string): string {
    return `${this.prefix}group:${groupId}:meta`;
  }

  job(jobId: string): string {
    return `${this.prefix}job:${jobId}`;
  }

  // ── Backpressure ──

  readyQueue(): string {
    return `${this.prefix}ready-queue`;
  }

  nonReadyQueue(): string {
    return `${this.prefix}non-ready-queue`;
  }

  rateLimitGroup(groupId: string, window: number): string {
    return `${this.prefix}rate-limit:${groupId}:${window}`;
  }

  rateLimitGlobal(window: number): string {
    return `${this.prefix}rate-limit:global:${window}`;
  }

  activeGroups(): string {
    return `${this.prefix}active-groups`;
  }

  // ── Congestion ──

  congestionNonReadyCount(groupId: string): string {
    return `${this.prefix}congestion:${groupId}:non-ready-count`;
  }

  congestionStats(groupId: string): string {
    return `${this.prefix}congestion:${groupId}:stats`;
  }

  congestionHistory(groupId: string): string {
    return `${this.prefix}congestion:${groupId}:history`;
  }

  congestionCompletedCount(groupId: string): string {
    return `${this.prefix}congestion:${groupId}:completed-count`;
  }
}
