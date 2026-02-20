import {
  BackoffRequest,
  BackoffResponse,
  CongestionLevel,
} from '@app/bulk-action/congestion/dto/BackoffDto';

export class BackoffCalculator {
  static calculate(params: BackoffRequest): BackoffResponse {
    const { nonReadyCount, rateLimitSpeed, baseBackoffMs, maxBackoffMs } =
      params;
    const safeSpeed = Math.max(1, rateLimitSpeed);

    const backoffMs = Math.min(
      baseBackoffMs + Math.floor(nonReadyCount / safeSpeed) * 1000,
      maxBackoffMs,
    );

    return BackoffResponse.calculate(
      backoffMs,
      nonReadyCount,
      safeSpeed,
      BackoffCalculator.classify(backoffMs, baseBackoffMs),
    );
  }

  static classify(backoffMs: number, baseBackoffMs: number): CongestionLevel {
    if (baseBackoffMs <= 0) {
      return CongestionLevel.NONE;
    }

    const ratio = backoffMs / baseBackoffMs;

    if (ratio <= 1) {
      return CongestionLevel.NONE;
    }

    if (ratio < 3) {
      return CongestionLevel.LOW;
    }

    if (ratio < 10) {
      return CongestionLevel.MODERATE;
    }

    if (ratio < 30) {
      return CongestionLevel.HIGH;
    }

    return CongestionLevel.CRITICAL;
  }

  static estimateCompletionTime(
    nonReadyCount: number,
    rateLimitSpeed: number,
  ): number {
    const safeSpeed = Math.max(1, rateLimitSpeed);

    return Math.ceil(nonReadyCount / safeSpeed) * 1000;
  }
}
