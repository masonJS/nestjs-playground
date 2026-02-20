import { RedisService } from '@app/redis/RedisService';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { BulkActionRequest } from '../model/BulkActionRequest';
import { Job } from '../model/job/Job';

export interface QueueStats {
  highPriorityGroups: number;
  normalPriorityGroups: number;
  lowPriorityGroups: number;
  totalGroups: number;
}

@Injectable()
export class FairQueueService {
  private readonly logger = new Logger(FairQueueService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async enqueue(options: BulkActionRequest): Promise<void> {
    const {
      groupId,
      jobId,
      jobProcessorType,
      payload,
      basePriority = 0,
      priorityLevel = PriorityLevel.NORMAL,
    } = options;

    const keys = [
      this.keys.fairQueue(priorityLevel),
      this.keys.groupJobs(groupId),
      this.keys.groupMeta(groupId),
      this.keys.job(jobId),
    ];

    const args = [
      groupId,
      jobId,
      JSON.stringify(payload),
      basePriority.toString(),
      priorityLevel,
      this.config.fairQueue.alpha.toString(),
      jobProcessorType,
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
      this.keys.fairQueue(PriorityLevel.HIGH),
      this.keys.fairQueue(PriorityLevel.NORMAL),
      this.keys.fairQueue(PriorityLevel.LOW),
    ];

    const args = [
      this.config.fairQueue.alpha.toString(),
      this.keys.getPrefix(),
    ];

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
    const keys = [this.keys.job(jobId), this.keys.groupMeta(groupId)];

    const result = await this.redisService.callCommand('ack', keys, []);
    const isGroupCompleted = result === 1;

    if (isGroupCompleted) {
      this.logger.log(`Group ${groupId} completed all jobs`);
    }

    return isGroupCompleted;
  }

  async getGroupPendingCount(groupId: string): Promise<number> {
    return this.redisService.list.length(this.keys.groupJobs(groupId));
  }

  async getQueueStats(): Promise<QueueStats> {
    const [highCount, normalCount, lowCount] = await Promise.all([
      this.redisService.sortedSet.count(
        this.keys.fairQueue(PriorityLevel.HIGH),
      ),
      this.redisService.sortedSet.count(
        this.keys.fairQueue(PriorityLevel.NORMAL),
      ),
      this.redisService.sortedSet.count(this.keys.fairQueue(PriorityLevel.LOW)),
    ]);

    return {
      highPriorityGroups: highCount,
      normalPriorityGroups: normalCount,
      lowPriorityGroups: lowCount,
      totalGroups: highCount + normalCount + lowCount,
    };
  }

  private parseJobFromRedis(raw: string[]): Job {
    const map: Record<string, string> = {};

    for (let i = 0; i < raw.length; i += 2) {
      map[raw[i]] = raw[i + 1];
    }

    return new Job(map);
  }
}
