export interface BackoffRequest {
  nonReadyCount: number;
  rateLimitSpeed: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export enum CongestionLevel {
  NONE = 'NONE',
  LOW = 'LOW',
  MODERATE = 'MODERATE',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export class BackoffResponse {
  backoffMs: number;
  nonReadyCount: number;
  rateLimitSpeed: number;
  congestionLevel: CongestionLevel;

  static fixedBackoff(baseBackoffMs: number): BackoffResponse {
    const backoff = new BackoffResponse();
    backoff.backoffMs = baseBackoffMs;
    backoff.nonReadyCount = 0;
    backoff.rateLimitSpeed = 0;
    backoff.congestionLevel = CongestionLevel.NONE;

    return backoff;
  }

  static calculate(
    backoffMs: number,
    nonReadyCount: number,
    rateLimitSpeed: number,
    congestionLevel: CongestionLevel,
  ): BackoffResponse {
    const backoff = new BackoffResponse();
    backoff.backoffMs = backoffMs;
    backoff.nonReadyCount = nonReadyCount;
    backoff.rateLimitSpeed = rateLimitSpeed;
    backoff.congestionLevel = congestionLevel;

    return backoff;
  }
}
