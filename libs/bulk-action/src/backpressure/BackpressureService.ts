import { Injectable } from '@nestjs/common';
import { RateLimiterService } from './RateLimiterService';
import { ReadyQueueService } from './ReadyQueueService';
import { CongestionControlService } from '../congestion/CongestionControlService';
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
    private readonly congestionControl: CongestionControlService,
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

    const backoffResult = await this.congestionControl.addToNonReady(
      job.id,
      job.groupId,
    );

    return {
      accepted: true,
      destination: 'non-ready',
      reason:
        `Rate limited (global: ${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
        `group: ${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit}, ` +
        `congestion: ${backoffResult.congestionLevel})`,
    };
  }

  async requeue(
    jobId: string,
    groupId: string,
    _retryCount: number,
  ): Promise<void> {
    await this.congestionControl.addToNonReady(jobId, groupId);
  }
}
