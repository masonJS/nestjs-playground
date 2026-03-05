import { RedisService } from '@app/redis/RedisService';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AggregatorService } from './aggregator/AggregatorService';
import { NonReadyQueueService } from './backpressure/NonReadyQueueService';
import { ReadyQueueService } from './backpressure/ReadyQueueService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from './config/BulkActionConfig';
import { CongestionControlService } from './congestion/CongestionControlService';
import { FairQueueService } from './fair-queue/FairQueueService';
import { RedisKeyBuilder } from './key/RedisKeyBuilder';
import { BulkActionRequest } from './model/BulkActionRequest';
import { GroupProgress, SubmitBulkJobsRequest } from './model/GroupProgress';
import { Job } from './model/job/Job';
import { WorkerPoolService } from './worker-pool/WorkerPoolService';

@Injectable()
export class BulkActionService {
  private readonly logger = new Logger(BulkActionService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly fairQueue: FairQueueService,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
    private readonly congestionControl: CongestionControlService,
    private readonly workerPool: WorkerPoolService,
    private readonly aggregatorService: AggregatorService,
  ) {}

  async submitJob(options: BulkActionRequest): Promise<void> {
    await this.fairQueue.enqueue(options);
    await this.redisService.set.add(
      this.keys.watcherActiveGroups(),
      options.jobGroupId,
    );

    this.logger.debug(
      `Job submitted: ${options.jobId} (group=${options.jobGroupId}, processorType=${options.jobProcessorType})`,
    );
  }

  async submitBulkJobs(request: SubmitBulkJobsRequest): Promise<number> {
    const { groupId, processorType, jobs, basePriority, priorityLevel } =
      request;

    for (const job of jobs) {
      await this.fairQueue.enqueue({
        jobGroupId: groupId,
        jobId: job.jobId,
        jobProcessorType: processorType,
        payload: job.payload,
        basePriority,
        priorityLevel,
      });
    }

    // Register watcher tracking
    await this.redisService.hash.set(
      this.keys.groupMeta(groupId),
      'registeredJobs',
      jobs.length.toString(),
    );
    await this.redisService.set.add(this.keys.watcherActiveGroups(), groupId);
    await this.redisService.hash.set(
      this.keys.groupMeta(groupId),
      'timeoutAt',
      (Date.now() + this.config.watcher.groupTimeoutMs).toString(),
    );

    this.logger.log(
      `Bulk submitted: ${jobs.length} jobs (group=${groupId}, processorType=${processorType})`,
    );

    return jobs.length;
  }

  // =========================================================================
  //  조회
  // =========================================================================

  async getJobStatus(jobId: string): Promise<Job | null> {
    const data = await this.redisService.hash.getAll(this.keys.job(jobId));

    if (!data || !data.id) {
      return null;
    }

    return new Job(data);
  }

  async getGroupProgress(groupId: string): Promise<GroupProgress> {
    const [meta, congestion, pendingInQueue] = await Promise.all([
      this.redisService.hash.getAll(this.keys.groupMeta(groupId)),
      this.congestionControl.getCongestionState(groupId),
      this.fairQueue.getGroupPendingCount(groupId),
    ]);

    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);
    const doneJobs = parseInt(meta.doneJobs ?? '0', 10);

    return {
      groupId,
      totalJobs,
      doneJobs,
      pendingInQueue,
      progressPercent:
        totalJobs > 0 ? Math.floor((doneJobs / totalJobs) * 100) : 0,
      status: meta.status ?? 'UNKNOWN',
      congestion: {
        level: congestion.congestionLevel,
        nonReadyCount: congestion.nonReadyCount,
        lastBackoffMs: congestion.lastBackoffMs,
      },
    };
  }

  async getQueueDepths(): Promise<{
    fairQueue: { high: number; normal: number; low: number; total: number };
    readyQueue: number;
    nonReadyQueue: number;
    deadLetterQueue: number;
  }> {
    const [fairQueueStats, readySize, nonReadySize, dlqSize] =
      await Promise.all([
        this.fairQueue.getQueueStats(),
        this.readyQueue.size(),
        this.nonReadyQueue.size(),
        this.redisService.list.length(this.keys.deadLetterQueue()),
      ]);

    return {
      fairQueue: {
        high: fairQueueStats.highPriorityGroups,
        normal: fairQueueStats.normalPriorityGroups,
        low: fairQueueStats.lowPriorityGroups,
        total: fairQueueStats.totalGroups,
      },
      readyQueue: readySize,
      nonReadyQueue: nonReadySize,
      deadLetterQueue: dlqSize,
    };
  }

  getPoolStatus() {
    return this.workerPool.getPoolStatus();
  }

  async getGroupResult(groupId: string): Promise<unknown | null> {
    return this.aggregatorService.getResult(groupId);
  }

  async getAggregatorProgress(groupId: string) {
    return this.aggregatorService.getProgress(groupId);
  }
}
