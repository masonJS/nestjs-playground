import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { AggregatorService } from '../aggregator/AggregatorService';
import { FairQueueService } from '../fair-queue/FairQueueService';

export interface OrphanRecoveryStats {
  totalCycles: number;
  totalRecovered: number;
  totalDeadLettered: number;
}

@Injectable()
export class OrphanRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrphanRecoveryService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private stats: OrphanRecoveryStats = {
    totalCycles: 0,
    totalRecovered: 0,
    totalDeadLettered: 0,
  };

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
    private readonly aggregatorService: AggregatorService,
    private readonly fairQueue: FairQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.intervalHandle = setInterval(
      () => void this.runOnce(),
      this.config.reliableQueue.orphanRecoveryIntervalMs,
    );

    this.logger.log(
      `Orphan recovery started (interval=${this.config.reliableQueue.orphanRecoveryIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Orphan recovery stopped');
    }
  }

  async runOnce(): Promise<{ recovered: number; deadLettered: number }> {
    const nowMs = Date.now();
    const jobKeyPrefix = this.keys.getPrefix() + 'job:';

    const result = (await this.redisService.callCommand(
      'recoverOrphans',
      [
        this.keys.inFlightQueue(),
        this.keys.readyQueue(),
        this.keys.deadLetterQueue(),
        this.keys.inFlightMetaPrefix(),
      ],
      [
        nowMs.toString(),
        this.config.reliableQueue.orphanRecoveryBatchSize.toString(),
        this.config.reliableQueue.maxRetryCount.toString(),
        jobKeyPrefix,
      ],
    )) as number[];

    const recovered = Number(result[0]);
    const deadLettered = Number(result[1]);

    this.stats.totalCycles++;
    this.stats.totalRecovered += recovered;
    this.stats.totalDeadLettered += deadLettered;

    if (recovered > 0 || deadLettered > 0) {
      this.logger.log(
        `Orphan recovery: recovered=${recovered}, deadLettered=${deadLettered}`,
      );
    }

    // deadLettered orphan 집계 처리
    if (deadLettered > 0) {
      const pairs = result.slice(2).map(String);
      await this.handleDeadLetteredOrphans(pairs);
    }

    return { recovered, deadLettered };
  }

  getStats(): OrphanRecoveryStats {
    return { ...this.stats };
  }

  private async handleDeadLetteredOrphans(pairs: string[]): Promise<void> {
    for (let i = 0; i < pairs.length; i += 2) {
      const jobId = pairs[i];
      const groupId = pairs[i + 1];

      await this.aggregatorService.recordJobResult({
        jobId,
        groupId,
        success: false,
        durationMs: 0,
        processorType: '',
        error: { message: 'orphan: max retries exceeded', retryable: false },
      });

      const isGroupCompleted = await this.fairQueue.ack(jobId, groupId);

      if (isGroupCompleted) {
        await this.aggregatorService.finalizeGroup(groupId);
      }
    }
  }
}
