import { BackoffResponse } from '../../congestion/dto/BackoffDto';
import { RateLimitResult } from '../RateLimiterService';

export enum BackpressureDestination {
  READY = 'ready',
  NON_READY = 'non-ready',
  REJECTED = 'rejected',
}

export class BackpressureResponse {
  private constructor(
    readonly accepted: boolean,
    readonly destination: BackpressureDestination,
    readonly reason?: string,
  ) {}

  static ready(): BackpressureResponse {
    return new BackpressureResponse(true, BackpressureDestination.READY);
  }

  static nonReady(
    rateLimitResult: RateLimitResult,
    backoffResult: BackoffResponse,
  ): BackpressureResponse {
    return new BackpressureResponse(
      true,
      BackpressureDestination.NON_READY,
      `Rate limited (global: ${rateLimitResult.globalCount}/${rateLimitResult.globalLimit}, ` +
        `group: ${rateLimitResult.groupCount}/${rateLimitResult.perGroupLimit}, ` +
        `congestion: ${backoffResult.congestionLevel})`,
    );
  }

  static rejected(reason: string): BackpressureResponse {
    return new BackpressureResponse(
      false,
      BackpressureDestination.REJECTED,
      reason,
    );
  }
}
