import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, BULK_ACTION_CONFIG } from '../redis/RedisProvider';
import { BulkActionConfig } from '../config/BulkActionConfig';
import { EnqueueOptions } from '../model/EnqueueOptions';
import { Job, JobStatus } from '../model/Job';
import { PriorityLevel } from '../model/JobGroup';

interface RedisWithCommands extends Redis {
  enqueue(
    queueKey: string,
    groupJobsKey: string,
    groupMetaKey: string,
    jobKey: string,
    groupId: string,
    jobId: string,
    payload: string,
    basePriority: string,
    priorityLevel: string,
    alpha: string,
    type: string,
  ): Promise<[number, number]>;

  dequeue(
    highKey: string,
    normalKey: string,
    lowKey: string,
    alpha: string,
    keyPrefix: string,
  ): Promise<string[] | null>;

  ack(jobKey: string, groupMetaKey: string): Promise<number>;
}

export interface QueueStats {
  highPriorityGroups: number;
  normalPriorityGroups: number;
  lowPriorityGroups: number;
  totalGroups: number;
}

@Injectable()
export class FairQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(FairQueueService.name);
  private readonly keyPrefix: string;
  private readonly redisWithCommands: RedisWithCommands;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {
    this.keyPrefix = config.redis.keyPrefix ?? 'bulk-action:';
    this.redisWithCommands = redis as unknown as RedisWithCommands;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
    this.logger.log('Redis connection closed');
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

    const queueKey = this.getQueueKey(priorityLevel);
    const groupJobsKey = this.getGroupJobsKey(groupId);
    const groupMetaKey = this.getGroupMetaKey(groupId);
    const jobKey = this.getJobKey(jobId);

    try {
      await this.redisWithCommands.enqueue(
        queueKey,
        groupJobsKey,
        groupMetaKey,
        jobKey,
        groupId,
        jobId,
        JSON.stringify(payload),
        basePriority.toString(),
        priorityLevel,
        this.config.fairQueue.alpha.toString(),
        type,
      );

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
    const highKey = this.getQueueKey(PriorityLevel.HIGH);
    const normalKey = this.getQueueKey(PriorityLevel.NORMAL);
    const lowKey = this.getQueueKey(PriorityLevel.LOW);

    try {
      const result = await this.redisWithCommands.dequeue(
        highKey,
        normalKey,
        lowKey,
        this.config.fairQueue.alpha.toString(),
        this.keyPrefix,
      );

      if (!result) {
        return null;
      }

      return this.parseJobFromRedis(result);
    } catch (error) {
      this.logger.error(`Failed to dequeue: ${error.message}`, error.stack);
      throw error;
    }
  }

  async ack(jobId: string, groupId: string): Promise<boolean> {
    const jobKey = this.getJobKey(jobId);
    const groupMetaKey = this.getGroupMetaKey(groupId);

    const result = await this.redisWithCommands.ack(jobKey, groupMetaKey);
    const isGroupCompleted = result === 1;

    if (isGroupCompleted) {
      this.logger.log(`Group ${groupId} completed all jobs`);
    }

    return isGroupCompleted;
  }

  async getGroupPendingCount(groupId: string): Promise<number> {
    return this.redis.llen(this.getGroupJobsKey(groupId));
  }

  async getQueueStats(): Promise<QueueStats> {
    const [highCount, normalCount, lowCount] = await Promise.all([
      this.redis.zcard(this.getQueueKey(PriorityLevel.HIGH)),
      this.redis.zcard(this.getQueueKey(PriorityLevel.NORMAL)),
      this.redis.zcard(this.getQueueKey(PriorityLevel.LOW)),
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
