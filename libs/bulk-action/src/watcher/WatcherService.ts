import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { DistributedLockService } from '../lock/DistributedLockService';
import { AggregatorService } from '../aggregator/AggregatorService';
import { GroupStatus } from '../model/job-group/type/GroupStatus';
import { StateMachine } from './StateMachine';

@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private readonly stateMachine = new StateMachine();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycleCount = 0;
  private groupsChecked = 0;
  private transitionsTriggered = 0;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly lockService: DistributedLockService,
    private readonly aggregatorService: AggregatorService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.intervalHandle = setInterval(() => {
      this.watchCycle().catch((err) => {
        this.logger.error(
          `Watch cycle error: ${(err as Error).message}`,
          (err as Error).stack,
        );
      });
    }, this.config.watcher.intervalMs);
    this.logger.log(
      `Watcher started (interval=${this.config.watcher.intervalMs}ms)`,
    );
  }

  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.logger.log('Watcher stopped');
  }

  getStats(): {
    cycleCount: number;
    groupsChecked: number;
    transitionsTriggered: number;
  } {
    return {
      cycleCount: this.cycleCount,
      groupsChecked: this.groupsChecked,
      transitionsTriggered: this.transitionsTriggered,
    };
  }

  async watchCycle(): Promise<void> {
    this.cycleCount++;
    const groupIds = await this.redisService.set.members(
      this.keys.watcherActiveGroups(),
    );

    for (const groupId of groupIds) {
      await this.checkGroup(groupId);
      this.groupsChecked++;
    }
  }

  private async checkGroup(groupId: string): Promise<void> {
    const meta = await this.redisService.hash.getAll(
      this.keys.groupMeta(groupId),
    );
    const status = meta.status as GroupStatus;

    if (!status) {
      return;
    }

    // Remove terminal states from active list
    if (this.stateMachine.isTerminal(status)) {
      await this.redisService.set.remove(
        this.keys.watcherActiveGroups(),
        groupId,
      );

      return;
    }

    // Check timeout first
    if (await this.checkTimeout(groupId, meta)) {
      return;
    }

    switch (status) {
      case GroupStatus.CREATED:
        await this.checkCreatedToDispatched(groupId, meta);
        break;
      case GroupStatus.DISPATCHED:
        await this.checkDispatchedToRunning(groupId, meta);
        break;
      case GroupStatus.RUNNING:
        await this.checkRunningToAggregating(groupId, meta);
        break;
      case GroupStatus.AGGREGATING:
        await this.checkAggregatingToCompleted(groupId, meta);
        break;
    }
  }

  private async checkCreatedToDispatched(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const registeredJobs = parseInt(meta.registeredJobs ?? '0', 10);
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);

    if (registeredJobs >= totalJobs && totalJobs > 0) {
      await this.transition(
        groupId,
        GroupStatus.CREATED,
        GroupStatus.DISPATCHED,
      );
    }
  }

  private async checkDispatchedToRunning(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const firstJobStartedAt = parseInt(meta.firstJobStartedAt ?? '0', 10);

    if (firstJobStartedAt > 0) {
      await this.transition(
        groupId,
        GroupStatus.DISPATCHED,
        GroupStatus.RUNNING,
      );
    }
  }

  private async checkRunningToAggregating(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const successCount = parseInt(meta.successCount ?? '0', 10);
    const failedCount = parseInt(meta.failedCount ?? '0', 10);
    const totalJobs = parseInt(meta.totalJobs ?? '0', 10);

    if (successCount + failedCount >= totalJobs && totalJobs > 0) {
      // Safety net: ack.lua should have already done this
      const lockKey = this.keys.groupTransitionLock(groupId);
      await this.lockService.withLock(lockKey, async () => {
        // Double-check inside lock
        const freshMeta = await this.redisService.hash.getAll(
          this.keys.groupMeta(groupId),
        );
        const freshStatus = freshMeta.status as GroupStatus;

        if (freshStatus === GroupStatus.RUNNING) {
          await this.aggregatorService.finalizeGroup(groupId);
        }
      });
    }
  }

  private async checkAggregatingToCompleted(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<void> {
    const aggregationStartAt = parseInt(meta.aggregationStartAt ?? '0', 10);
    const { staleGroupThresholdMs } = this.config.watcher;

    if (aggregationStartAt === 0) {
      // ack.lua just transitioned to AGGREGATING, trigger aggregation
      this.logger.log(
        `Group ${groupId}: AGGREGATING with no aggregationStartAt, triggering finalize`,
      );
      await this.aggregatorService.finalizeGroup(groupId);
    } else if (Date.now() - aggregationStartAt > staleGroupThresholdMs) {
      // Previous aggregation failed, retry
      this.logger.warn(
        `Group ${groupId}: stale AGGREGATING (started ${
          Date.now() - aggregationStartAt
        }ms ago), retrying`,
      );
      await this.aggregatorService.finalizeGroup(groupId);
    }
  }

  private async checkTimeout(
    groupId: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    const timeoutAt = parseInt(meta.timeoutAt ?? '0', 10);

    if (timeoutAt > 0 && Date.now() > timeoutAt) {
      const status = meta.status as GroupStatus;

      if (!this.stateMachine.isTerminal(status)) {
        this.logger.warn(`Group ${groupId} timed out (status=${status})`);
        await this.forceTransition(groupId, status, GroupStatus.FAILED);

        return true;
      }
    }

    return false;
  }

  private async transition(
    groupId: string,
    from: GroupStatus,
    to: GroupStatus,
  ): Promise<boolean> {
    if (!this.stateMachine.isValidTransition(from, to)) {
      return false;
    }

    const result = await this.aggregatorService.transition(groupId, from, to);

    if (result) {
      this.transitionsTriggered++;
      this.logger.log(`Group ${groupId}: ${from} → ${to}`);
    }

    return result;
  }

  private async forceTransition(
    groupId: string,
    currentStatus: GroupStatus,
    to: GroupStatus,
  ): Promise<void> {
    if (this.stateMachine.isTerminal(currentStatus)) {
      return;
    }

    if (!this.stateMachine.isValidTransition(currentStatus, to)) {
      this.logger.warn(
        `Group ${groupId}: invalid forced transition ${currentStatus} → ${to}`,
      );

      return;
    }

    if (this.stateMachine.requiresLock(currentStatus, to)) {
      const lockKey = this.keys.groupAggregationLock(groupId);
      const result = await this.lockService.withLock(lockKey, async () => {
        // Double-check after lock acquisition
        const freshMeta = await this.redisService.hash.getAll(
          this.keys.groupMeta(groupId),
        );
        const freshStatus = freshMeta.status as GroupStatus;

        if (this.stateMachine.isTerminal(freshStatus)) {
          return false;
        }

        if (!this.stateMachine.isValidTransition(freshStatus, to)) {
          return false;
        }

        return this.aggregatorService.transition(groupId, freshStatus, to);
      });

      if (result) {
        this.transitionsTriggered++;
        this.logger.warn(`Group ${groupId}: forced ${currentStatus} → ${to}`);
      }

      return;
    }

    const result = await this.aggregatorService.transition(
      groupId,
      currentStatus,
      to,
    );

    if (result) {
      this.transitionsTriggered++;
      this.logger.warn(`Group ${groupId}: forced ${currentStatus} → ${to}`);
    }
  }
}
