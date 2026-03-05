import { Injectable } from '@nestjs/common';
import { Aggregator, AggregationContext } from './AggregatorInterface';

export interface DefaultMapResult {
  success: boolean;
  durationMs: number;
  error?: string;
  jobId: string;
}

export interface DefaultReduceResult {
  successCount: number;
  failedCount: number;
  totalJobs: number;
  averageDurationMs: number;
  failedJobIds: string[];
}

@Injectable()
export class DefaultAggregator
  implements Aggregator<DefaultMapResult, DefaultReduceResult>
{
  readonly type = '__default__';

  map(jobResult: Record<string, unknown>): DefaultMapResult {
    return {
      success: jobResult.success === true || jobResult.success === 'true',
      durationMs: Number(jobResult.durationMs ?? 0),
      error: jobResult.error as string | undefined,
      jobId: jobResult.jobId as string,
    };
  }

  reduce(
    mapped: DefaultMapResult[],
    context: AggregationContext,
  ): DefaultReduceResult {
    let totalDuration = 0;
    const failedJobIds: string[] = [];

    for (const item of mapped) {
      totalDuration += item.durationMs;

      if (!item.success) {
        failedJobIds.push(item.jobId);
      }
    }

    return {
      successCount: context.successCount,
      failedCount: context.failedCount,
      totalJobs: context.totalJobs,
      averageDurationMs:
        mapped.length > 0 ? Math.floor(totalDuration / mapped.length) : 0,
      failedJobIds,
    };
  }
}
