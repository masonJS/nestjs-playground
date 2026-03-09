import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';

export interface InFlightEntry {
  jobId: string;
  workerId: string;
  instanceId: string;
  deadline: number;
  dequeuedAt: number;
  retryCount: number;
  groupId: string;
}

@Injectable()
export class InFlightQueueService {
  constructor(
    private readonly redisService: RedisService,
    private readonly keys: RedisKeyBuilder,
  ) {}

  async size(): Promise<number> {
    return this.redisService.sortedSet.count(this.keys.inFlightQueue());
  }

  async isInFlight(jobId: string): Promise<boolean> {
    const score = await this.redisService.sortedSet.score(
      this.keys.inFlightQueue(),
      jobId,
    );

    return score !== null;
  }

  async orphanedCount(): Promise<number> {
    return this.redisService.sortedSet.countByScore(
      this.keys.inFlightQueue(),
      '-inf',
      Date.now().toString(),
    );
  }

  async getEntry(jobId: string): Promise<InFlightEntry | null> {
    const data = await this.redisService.hash.getAll(
      this.keys.inFlightMeta(jobId),
    );

    if (!data || !data.jobId) {
      return null;
    }

    return {
      jobId: data.jobId,
      workerId: data.workerId,
      instanceId: data.instanceId,
      deadline: parseInt(data.deadline, 10),
      dequeuedAt: parseInt(data.dequeuedAt, 10),
      retryCount: parseInt(data.retryCount, 10),
      groupId: data.groupId,
    };
  }

  async getAllEntries(): Promise<Array<{ jobId: string; deadline: number }>> {
    const entries = await this.redisService.sortedSet.rangeWithScores(
      this.keys.inFlightQueue(),
      0,
      -1,
    );

    return entries.map((e) => ({
      jobId: e.member,
      deadline: e.score,
    }));
  }
}
