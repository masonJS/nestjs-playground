import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { EnqueueOptions } from '../model/EnqueueOptions';
import { Job, JobStatus } from '../model/Job';
import { PriorityLevel } from '../model/JobGroup';

export interface QueueStats {
  highPriorityGroups: number;
  normalPriorityGroups: number;
  lowPriorityGroups: number;
  totalGroups: number;
}

@Injectable()
export class FairQueueService {
  private readonly logger = new Logger(FairQueueService.name);
  private readonly keyPrefix: string;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {
    this.keyPrefix = config.redis.keyPrefix ?? 'bulk-action:';
  }

  async enqueue(options: EnqueueOptions): Promise<void> {
    const {
      groupId,
      jobId,
      type,
      payload,
      basePriority = 0,
      priorityLevel = PriorityLevel.NORMAL,
    } = options;

    const keys = [
      this.getQueueKey(priorityLevel),
      this.getGroupJobsKey(groupId),
      this.getGroupMetaKey(groupId),
      this.getJobKey(jobId),
    ];

    const args = [
      groupId,
      jobId,
      JSON.stringify(payload),
      basePriority.toString(),
      priorityLevel,
      this.config.fairQueue.alpha.toString(),
      type,
    ];

    try {
      await this.redisService.callCommand('enqueue', keys, args);

      this.logger.debug(
        `Enqueued job ${jobId} for group ${groupId} at ${priorityLevel} priority`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue job ${jobId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async dequeue(): Promise<Job | null> {
    const keys = [
      this.getQueueKey(PriorityLevel.HIGH),
      this.getQueueKey(PriorityLevel.NORMAL),
      this.getQueueKey(PriorityLevel.LOW),
    ];

    const args = [this.config.fairQueue.alpha.toString(), this.keyPrefix];

    try {
      const result = await this.redisService.callCommand('dequeue', keys, args);

      if (!result) {
        return null;
      }

      return this.parseJobFromRedis(result as string[]);
    } catch (error) {
      this.logger.error(`Failed to dequeue: ${error.message}`, error.stack);
      throw error;
    }
  }

  async ack(jobId: string, groupId: string): Promise<boolean> {
    const keys = [this.getJobKey(jobId), this.getGroupMetaKey(groupId)];

    const result = await this.redisService.callCommand('ack', keys, []);
    const isGroupCompleted = result === 1;

    if (isGroupCompleted) {
      this.logger.log(`Group ${groupId} completed all jobs`);
    }

    return isGroupCompleted;
  }

  async getGroupPendingCount(groupId: string): Promise<number> {
    return this.redisService.getListLength(this.getGroupJobsKey(groupId));
  }

  async getQueueStats(): Promise<QueueStats> {
    const [highCount, normalCount, lowCount] = await Promise.all([
      this.redisService.getSortedSetCount(this.getQueueKey(PriorityLevel.HIGH)),
      this.redisService.getSortedSetCount(
        this.getQueueKey(PriorityLevel.NORMAL),
      ),
      this.redisService.getSortedSetCount(this.getQueueKey(PriorityLevel.LOW)),
    ]);

    return {
      highPriorityGroups: highCount,
      normalPriorityGroups: normalCount,
      lowPriorityGroups: lowCount,
      totalGroups: highCount + normalCount + lowCount,
    };
  }

  private getQueueKey(level: PriorityLevel): string {
    return `${this.keyPrefix}fair-queue:${level}`;
  }

  private getGroupJobsKey(groupId: string): string {
    return `${this.keyPrefix}group:${groupId}:jobs`;
  }

  private getGroupMetaKey(groupId: string): string {
    return `${this.keyPrefix}group:${groupId}:meta`;
  }

  private getJobKey(jobId: string): string {
    return `${this.keyPrefix}job:${jobId}`;
  }

  private parseJobFromRedis(raw: string[]): Job {
    const map: Record<string, string> = {};

    for (let i = 0; i < raw.length; i += 2) {
      map[raw[i]] = raw[i + 1];
    }

    return {
      id: map.id,
      groupId: map.groupId,
      type: map.type ?? '',
      payload: map.payload ?? '{}',
      status: (map.status as JobStatus) ?? JobStatus.PENDING,
      retryCount: parseInt(map.retryCount ?? '0', 10),
      createdAt: parseInt(map.createdAt ?? '0', 10),
    };
  }
}
