export interface AggregationContext {
  groupId: string;
  totalJobs: number;
  successCount: number;
  failedCount: number;
}

export interface Aggregator<T = unknown, R = unknown> {
  readonly type: string;

  map(jobResult: Record<string, unknown>): T;

  reduce(mapped: T[], context: AggregationContext): R;
}

export const AGGREGATOR = Symbol('AGGREGATOR');
