import { Injectable, Inject } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface CongestionSnapshot {
  nonReadyCount: number;
  rateLimitSpeed: number;
  backoffMs: number;
  timestamp: number;
}

@Injectable()
export class CongestionStatsService {
  private readonly maxHistoryLength: number;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {
    this.maxHistoryLength = Math.floor(
      this.config.congestion.statsRetentionMs / 1000,
    );
  }

  async recordJobCompletion(
    groupId: string,
    throttleCount: number,
  ): Promise<void> {
    const completedKey = this.keys.congestionCompletedCount(groupId);
    const statsKey = this.keys.congestionStats(groupId);

    await this.redisService.string.increment(completedKey);

    const completedRaw = await this.redisService.string.get(completedKey);
    const completed = parseInt(completedRaw ?? '1', 10);
    const prevAvgRaw = await this.redisService.hash.get(
      statsKey,
      'avgThrottlePerJob',
    );
    const prevAvg = parseFloat(prevAvgRaw ?? '0');

    const newAvg = prevAvg + (throttleCount - prevAvg) / completed;
    await this.redisService.hash.set(
      statsKey,
      'avgThrottlePerJob',
      newAvg.toFixed(2),
    );
  }

  async snapshotCongestion(
    groupId: string,
    snapshot: CongestionSnapshot,
  ): Promise<void> {
    const historyKey = this.keys.congestionHistory(groupId);

    await this.redisService.list.append(historyKey, JSON.stringify(snapshot));
    await this.redisService.list.trim(historyKey, -this.maxHistoryLength, -1);
  }

  async getCongestionHistory(
    groupId: string,
    limit: number,
  ): Promise<CongestionSnapshot[]> {
    const historyKey = this.keys.congestionHistory(groupId);
    const entries = await this.redisService.list.range(historyKey, -limit, -1);

    return entries.map((entry) => JSON.parse(entry) as CongestionSnapshot);
  }
}
