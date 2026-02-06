import { Injectable } from '@nestjs/common';
import { RateLimiterService } from './RateLimiterService';
import { ReadyQueueService } from './ReadyQueueService';
import { NonReadyQueueService, NonReadyReason } from './NonReadyQueueService';
import { Job } from '../model/Job';

export interface BackpressureResult {
  accepted: boolean;
  destination: 'ready' | 'non-ready' | 'rejected';
  reason?: string;
}

@Injectable()
export class BackpressureService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly readyQueue: ReadyQueueService,
    private readonly nonReadyQueue: NonReadyQueueService,
  ) {}

  async admit(job: Job): Promise<BackpressureResult> {
    const hasCapacity = await this.readyQueue.hasCapacity();

    if (!hasCapacity) {
      return {
        accepted: false,
        destination: 'rejected',
        reason: 'Ready Queue at capacity',
      };
    }

    const rateLimitResult = await this.rateLimiter.checkRateLimit(job.groupId);

    if (rateLimitResult.allowed) {
      const pushed = await this.readyQueue.push(job.id);

      if (!pushed) {
        return {
          accepted: false,
          destination: 'rejected',
          reason: 'Ready Queue became full',
        };
      }

      return { accepted: true, destination: 'ready' };
    }

    const backoffMs = this.calculateBackoff();
    await this.nonReadyQueue.push(
      job.id,
      backoffMs,
      NonReadyReason.RATE_LIMITED,
    );
    await this.nonReadyQueue.incrementGroupCount(job.groupId);

    return {
      accepted: true,
      destination: 'non-ready',
      reason:
        `Rate limited (global: ${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
        `group: ${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit})`,
    };
  }

  async requeue(
    jobId: string,
    groupId: string,
    retryCount: number,
  ): Promise<void> {
    await this.nonReadyQueue.pushWithExponentialBackoff(
      jobId,
      retryCount,
      NonReadyReason.TRANSIENT_ERROR,
    );
    await this.nonReadyQueue.incrementGroupCount(groupId);
  }

  // Step 3 혼잡 제어에서 동적 backoff 계산으로 교체 예정
  private calculateBackoff(): number {
    return 1000;
  }
}
