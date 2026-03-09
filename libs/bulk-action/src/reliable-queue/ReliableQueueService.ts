import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '../config/BulkActionConfig';
import { RedisKeyBuilder } from '../key/RedisKeyBuilder';
import { DequeueResult } from './DequeueResult';

@Injectable()
export class ReliableQueueService {
  private readonly logger = new Logger(ReliableQueueService.name);
  private readonly instanceId: string;

  constructor(
    private readonly redisService: RedisService,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
    private readonly keys: RedisKeyBuilder,
  ) {
    this.instanceId = randomUUID();
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  async dequeue(workerId: string): Promise<DequeueResult | null> {
    const readyQueueKey = this.keys.readyQueue();
    const length = await this.redisService.list.length(readyQueueKey);

    if (length === 0) {
      return null;
    }

    // Pre-fetch retryCount/groupId via LINDEX peek
    const peekResult = await this.redisService.list.range(readyQueueKey, 0, 0);
    let retryCount = '0';
    let groupId = '';

    if (peekResult.length > 0) {
      const peekJobId = peekResult[0];
      const jobKey = this.keys.job(peekJobId);
      retryCount =
        (await this.redisService.hash.get(jobKey, 'retryCount')) ?? '0';
      groupId = (await this.redisService.hash.get(jobKey, 'groupId')) ?? '';
    }

    const result = await this.redisService.callCommand(
      'reliableDequeue',
      [
        readyQueueKey,
        this.keys.inFlightQueue(),
        this.keys.inFlightMetaPrefix(),
      ],
      [
        this.config.reliableQueue.ackTimeoutMs.toString(),
        workerId,
        this.instanceId,
        retryCount,
        groupId,
      ],
    );

    if (!result) {
      return null;
    }

    const [jobId, deadline] = result as string[];

    this.logger.debug(
      `Dequeued job ${jobId} for worker ${workerId} (deadline=${deadline})`,
    );

    return { jobId, deadline: parseInt(deadline, 10) };
  }

  async ack(jobId: string): Promise<boolean> {
    const result = await this.redisService.callCommand(
      'reliableAck',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId],
    );

    const removed = result === 1;

    if (!removed) {
      this.logger.warn(`Late ACK for job ${jobId} (already recovered)`);
    }

    return removed;
  }

  async nack(jobId: string): Promise<void> {
    await this.redisService.callCommand(
      'reliableAck',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId],
    );
  }

  async extendDeadline(jobId: string, extensionMs?: number): Promise<boolean> {
    const extension = extensionMs ?? this.config.reliableQueue.ackTimeoutMs;

    const result = await this.redisService.callCommand(
      'extendDeadline',
      [this.keys.inFlightQueue(), this.keys.inFlightMetaPrefix()],
      [jobId, extension.toString()],
    );

    return result === 1;
  }
}
