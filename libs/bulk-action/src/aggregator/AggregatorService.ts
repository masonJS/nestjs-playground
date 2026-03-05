import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { DistributedLockService } from '../lock/DistributedLockService';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { GroupStatus } from '../model/job-group/type/GroupStatus';
import {
  Aggregator,
  AGGREGATOR,
  AggregationContext,
} from './AggregatorInterface';

export interface RecordResult {
  isGroupComplete: boolean;
  successCount: number;
  failedCount: number;
  totalJobs: number;
}

export interface GroupProgress {
  groupId: string;
  totalJobs: number;
  successCount: number;
  failedCount: number;
  doneJobs: number;
  progressPercent: number;
  status: string;
}

const BATCH_SIZE = 5000;

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);
  private readonly aggregatorMap = new Map<string, Aggregator>();

  constructor(
    private readonly redisService: RedisService,
    private readonly keys: RedisKeyBuilder,
    private readonly lockService: DistributedLockService,
    @Inject(AGGREGATOR) aggregators: Aggregator[],
  ) {
    for (const agg of aggregators) {
      this.aggregatorMap.set(agg.type, agg);
    }
  }

  async recordJobResult(
    jobResult: JobProcessorResponse,
  ): Promise<RecordResult> {
    const resultType = jobResult.success ? 'success' : 'failed';
    const resultJson = JSON.stringify({
      jobId: jobResult.jobId,
      groupId: jobResult.groupId,
      success: jobResult.success,
      durationMs: jobResult.durationMs,
      error: jobResult.error,
      processorType: jobResult.processorType,
      data: jobResult.data,
    });

    const keys = [
      this.keys.groupMeta(jobResult.groupId),
      this.keys.groupJobResults(jobResult.groupId),
    ];
    const args = [resultType, resultJson, Date.now().toString()];

    const result = (await this.redisService.callCommand(
      'recordJobResult',
      keys,
      args,
    )) as number[];

    return {
      isGroupComplete: result[0] === 1,
      successCount: result[1],
      failedCount: result[2],
      totalJobs: result[3],
    };
  }

  async aggregate(groupId: string, processorType?: string): Promise<unknown> {
    const meta = await this.redisService.hash.getAll(
      this.keys.groupMeta(groupId),
    );
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const successCount = parseInt(meta.successCount ?? '0', 10);
    const failedCount = parseInt(meta.failedCount ?? '0', 10);

    const aggregator = this.resolveAggregator(processorType);

    const context: AggregationContext = {
      groupId,
      totalJobs,
      successCount,
      failedCount,
    };

    // Batch load job results
    const allMapped: unknown[] = [];
    const listKey = this.keys.groupJobResults(groupId);
    let offset = 0;

    while (true) {
      const batch = await this.redisService.list.range(
        listKey,
        offset,
        offset + BATCH_SIZE - 1,
      );

      if (batch.length === 0) {
        break;
      }

      for (const raw of batch) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        allMapped.push(aggregator.map(parsed));
      }

      offset += batch.length;

      if (batch.length < BATCH_SIZE) {
        break;
      }
    }

    const result = aggregator.reduce(allMapped as never[], context);

    // Store result
    await this.redisService.hash.set(
      this.keys.groupResult(groupId),
      'result',
      JSON.stringify(result),
    );
    await this.redisService.hash.set(
      this.keys.groupResult(groupId),
      'aggregatedAt',
      Date.now().toString(),
    );

    this.logger.log(
      `Aggregated group ${groupId}: ${successCount} success, ${failedCount} failed`,
    );

    return result;
  }

  async finalizeGroup(groupId: string): Promise<boolean> {
    const result = await this.lockService.withLock(
      this.keys.groupAggregationLock(groupId),
      async () => {
        const meta = await this.redisService.hash.getAll(
          this.keys.groupMeta(groupId),
        );
        const status = meta.status as GroupStatus;

        // ack.lua already set AGGREGATING — proceed to aggregate
        if (status === GroupStatus.AGGREGATING) {
          const processorType = meta.processorType;
          await this.aggregate(groupId, processorType);
          const transitioned = await this.transition(
            groupId,
            GroupStatus.AGGREGATING,
            GroupStatus.COMPLETED,
          );

          if (!transitioned) {
            this.logger.warn(
              `Group ${groupId}: AGGREGATING → COMPLETED transition failed (status may have changed)`,
            );
          }

          return transitioned;
        }

        // Try RUNNING → AGGREGATING first
        if (status === GroupStatus.RUNNING) {
          const transitioned = await this.transition(
            groupId,
            GroupStatus.RUNNING,
            GroupStatus.AGGREGATING,
          );

          if (!transitioned) {
            return false;
          }

          const processorType = meta.processorType;
          await this.aggregate(groupId, processorType);
          const completed = await this.transition(
            groupId,
            GroupStatus.AGGREGATING,
            GroupStatus.COMPLETED,
          );

          if (!completed) {
            this.logger.warn(
              `Group ${groupId}: AGGREGATING → COMPLETED transition failed (status may have changed)`,
            );
          }

          return completed;
        }

        // Already COMPLETED or FAILED — no-op
        return false;
      },
    );

    return result ?? false;
  }

  async getResult(groupId: string): Promise<unknown | null> {
    const raw = await this.redisService.hash.get(
      this.keys.groupResult(groupId),
      'result',
    );

    if (!raw) {
      return null;
    }

    return JSON.parse(raw);
  }

  async getProgress(groupId: string): Promise<GroupProgress> {
    const meta = await this.redisService.hash.getAll(
      this.keys.groupMeta(groupId),
    );
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const successCount = parseInt(meta.successCount ?? '0', 10);
    const failedCount = parseInt(meta.failedCount ?? '0', 10);
    const doneJobs = parseInt(meta.doneJobs ?? '0', 10);

    return {
      groupId,
      totalJobs,
      successCount,
      failedCount,
      doneJobs,
      progressPercent:
        totalJobs > 0 ? Math.floor((doneJobs / totalJobs) * 100) : 0,
      status: meta.status ?? 'UNKNOWN',
    };
  }

  async transition(
    groupId: string,
    from: GroupStatus,
    to: GroupStatus,
  ): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'transitionStatus',
      [this.keys.groupMeta(groupId)],
      [from, to, Date.now().toString()],
    );

    return result === 1;
  }

  private resolveAggregator(processorType?: string): Aggregator {
    if (processorType) {
      const agg = this.aggregatorMap.get(processorType);

      if (agg) {
        return agg;
      }
    }

    const defaultAgg = this.aggregatorMap.get('__default__');

    if (!defaultAgg) {
      throw new Error('No default aggregator registered');
    }

    return defaultAgg;
  }
}
