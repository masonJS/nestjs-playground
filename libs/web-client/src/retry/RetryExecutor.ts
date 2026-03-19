import { RetryPolicy } from '@app/web-client/retry/RetryPolicy';

export class RetryExecutor {
  static async execute<T>(
    action: () => Promise<T>,
    policy: RetryPolicy,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      try {
        return await action();
      } catch (e) {
        lastError = e;

        if (attempt < policy.maxRetries) {
          const delayMs = RetryExecutor.calculateDelay(attempt, policy);
          await RetryExecutor.sleep(delayMs);
        }
      }
    }

    throw lastError;
  }

  static calculateDelay(retryCount: number, policy: RetryPolicy): number {
    const baseDelay =
      policy.multiplier > 0
        ? policy.delay * Math.pow(policy.multiplier, retryCount)
        : policy.delay;

    const jitter = policy.jitter > 0 ? Math.random() * policy.jitter : 0;

    const totalDelay = baseDelay + jitter;

    if (policy.maxDelay > 0) {
      return Math.min(totalDelay, policy.maxDelay);
    }

    return totalDelay;
  }

  private static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
