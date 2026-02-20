import { Injectable } from '@nestjs/common';
import { BackpressureResponse } from '@app/bulk-action/backpressure/dto/BackpressureDto';
import { RateLimiterService } from './RateLimiterService';
import { ReadyQueueService } from './ReadyQueueService';
import { CongestionControlService } from '../congestion/CongestionControlService';
import { Job } from '../model/job/Job';

@Injectable()
export class BackpressureService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly readyQueue: ReadyQueueService,
    private readonly congestionControl: CongestionControlService,
  ) {}

  async admit(job: Job): Promise<BackpressureResponse> {
    const hasCapacity = await this.readyQueue.hasCapacity();

    if (!hasCapacity) {
      return BackpressureResponse.rejected('Ready Queue at capacity');
    }

    const rateLimitResult = await this.rateLimiter.checkRateLimit(job.groupId);

    if (rateLimitResult.allowed) {
      const pushed = await this.readyQueue.push(job.id);

      if (!pushed) {
        return BackpressureResponse.rejected('Ready Queue became full');
      }

      return BackpressureResponse.ready();
    }

    const backoffResult = await this.congestionControl.addToNonReady(
      job.id,
      job.groupId,
    );

    return BackpressureResponse.nonReady(rateLimitResult, backoffResult);
  }

  async requeue(jobId: string, groupId: string): Promise<void> {
    await this.congestionControl.addToNonReady(jobId, groupId);
  }
}
