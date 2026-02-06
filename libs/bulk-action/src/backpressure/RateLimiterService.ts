import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface RateLimitResult {
  allowed: boolean;
  globalCount: number;
  globalLimit: number;
  groupCount: number;
  perGroupLimit: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async checkRateLimit(groupId: string): Promise<RateLimitResult> {
    const { globalRps, rateLimitKeyTtlSec } = this.config.backpressure;
    const window = this.currentWindow();

    const result = (await this.redisService.callCommand(
      'rateLimitCheck',
      [
        this.keys.rateLimitGroup(groupId, window),
        this.keys.rateLimitGlobal(window),
        this.keys.activeGroups(),
      ],
      [globalRps.toString(), groupId, rateLimitKeyTtlSec.toString()],
    )) as number[];

    const rateLimitResult: RateLimitResult = {
      allowed: result[0] === 1,
      globalCount: result[1],
      globalLimit: result[2],
      groupCount: result[3],
      perGroupLimit: result[4],
    };

    if (!rateLimitResult.allowed) {
      this.logger.debug(
        `Rate limited: group=${groupId}, ` +
          `global=${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
          `group=${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit}`,
      );
    }

    return rateLimitResult;
  }

  async getStatus(groupId: string): Promise<{
    globalCount: number;
    globalLimit: number;
    groupCount: number;
    perGroupLimit: number;
    activeGroupCount: number;
  }> {
    const window = this.currentWindow();

    const [globalRaw, groupRaw, activeGroupCount] = await Promise.all([
      this.redisService.string.get(this.keys.rateLimitGlobal(window)),
      this.redisService.string.get(this.keys.rateLimitGroup(groupId, window)),
      this.redisService.set.size(this.keys.activeGroups()),
    ]);

    const globalCount = parseInt(globalRaw ?? '0', 10);
    const groupCount = parseInt(groupRaw ?? '0', 10);
    const perGroupLimit = Math.max(
      1,
      Math.floor(
        this.config.backpressure.globalRps / Math.max(1, activeGroupCount),
      ),
    );

    return {
      globalCount,
      globalLimit: this.config.backpressure.globalRps,
      groupCount,
      perGroupLimit,
      activeGroupCount,
    };
  }

  async deactivateGroup(groupId: string): Promise<void> {
    await this.redisService.set.remove(this.keys.activeGroups(), groupId);
    this.logger.debug(`Deactivated group: ${groupId}`);
  }

  private currentWindow(): number {
    return Math.floor(
      Date.now() / (this.config.backpressure.rateLimitWindowSec * 1000),
    );
  }
}
