import {
  BackoffResponse,
  CongestionLevel,
} from '@app/bulk-action/congestion/dto/BackoffDto';
import { RedisService } from '@app/redis/RedisService';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { BackoffCalculator } from './BackoffCalculator';

export interface GroupCongestionState {
  groupId: string;
  nonReadyCount: number;
  rateLimitSpeed: number;
  lastBackoffMs: number;
  congestionLevel: CongestionLevel;
}

export interface SystemCongestionSummary {
  totalNonReadyCount: number;
  activeGroupCount: number;
  groups: GroupCongestionState[];
}

@Injectable()
export class CongestionControlService {
  private readonly logger = new Logger(CongestionControlService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async addToNonReady(
    jobId: string,
    groupId: string,
  ): Promise<BackoffResponse> {
    if (!this.config.congestion.enabled) {
      return this.fixedBackoff(jobId, groupId);
    }

    try {
      const result = (await this.redisService.callCommand(
        'congestionBackoff',
        [
          this.keys.nonReadyQueue(),
          this.keys.congestionStats(groupId),
          this.keys.congestionNonReadyCount(groupId),
          this.keys.activeGroups(),
        ],
        [
          jobId,
          this.config.backpressure.globalRps.toString(),
          this.config.congestion.baseBackoffMs.toString(),
          this.config.congestion.maxBackoffMs.toString(),
          Date.now().toString(),
        ],
      )) as number[];

      const backoffResult = BackoffCalculator.calculate({
        nonReadyCount: result[1],
        rateLimitSpeed: result[2],
        baseBackoffMs: this.config.congestion.baseBackoffMs,
        maxBackoffMs: this.config.congestion.maxBackoffMs,
      });

      this.logger.debug(
        `Job ${jobId} -> Non-ready (group=${groupId}, backoff=${backoffResult.backoffMs}ms, ` +
          `level=${backoffResult.congestionLevel}, count=${backoffResult.nonReadyCount})`,
      );

      return backoffResult;
    } catch (error) {
      this.logger.error(
        `Congestion backoff failed for ${jobId}, falling back to fixed: ${
          (error as Error).message
        }`,
      );

      return this.fixedBackoff(jobId, groupId);
    }
  }

  async releaseFromNonReady(groupId: string, count: number): Promise<number> {
    try {
      const result = await this.redisService.callCommand(
        'congestionRelease',
        [
          this.keys.congestionNonReadyCount(groupId),
          this.keys.congestionStats(groupId),
        ],
        [count.toString()],
      );

      return result as number;
    } catch (error) {
      this.logger.error(
        `Congestion release failed for ${groupId}: ${(error as Error).message}`,
      );

      return 0;
    }
  }

  async getCongestionState(groupId: string): Promise<GroupCongestionState> {
    const [countRaw, stats, activeGroupCount] = await Promise.all([
      this.redisService.string.get(this.keys.congestionNonReadyCount(groupId)),
      this.redisService.hash.getAll(this.keys.congestionStats(groupId)),
      this.redisService.set.size(this.keys.activeGroups()),
    ]);

    const nonReadyCount = parseInt(countRaw ?? '0', 10);
    const rateLimitSpeed = Math.max(
      1,
      Math.floor(
        this.config.backpressure.globalRps / Math.max(1, activeGroupCount),
      ),
    );
    const lastBackoffMs = parseInt(stats.lastBackoffMs ?? '0', 10);

    return {
      groupId,
      nonReadyCount,
      rateLimitSpeed,
      lastBackoffMs,
      congestionLevel: BackoffCalculator.classify(
        lastBackoffMs,
        this.config.congestion.baseBackoffMs,
      ),
    };
  }

  async getSystemCongestionSummary(): Promise<SystemCongestionSummary> {
    const groupIds = await this.redisService.set.members(
      this.keys.activeGroups(),
    );

    const groups = await Promise.all(
      groupIds.map(async (groupId) => this.getCongestionState(groupId)),
    );

    const totalNonReadyCount = groups.reduce(
      (sum, g) => sum + g.nonReadyCount,
      0,
    );

    return {
      totalNonReadyCount,
      activeGroupCount: groupIds.length,
      groups,
    };
  }

  async resetGroupStats(groupId: string): Promise<void> {
    await this.redisService.delete(
      this.keys.congestionNonReadyCount(groupId),
      this.keys.congestionStats(groupId),
    );
  }

  private async fixedBackoff(
    jobId: string,
    groupId: string,
  ): Promise<BackoffResponse> {
    const backoffMs = this.config.congestion.baseBackoffMs;
    const executeAt = Date.now() + backoffMs;

    await this.redisService.sortedSet.add(
      this.keys.nonReadyQueue(),
      executeAt,
      jobId,
    );

    this.logger.debug(
      `Job ${jobId} -> Non-ready fixed backoff (group=${groupId}, backoff=${backoffMs}ms)`,
    );

    return BackoffResponse.fixedBackoff(backoffMs);
  }
}
