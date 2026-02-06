import { RedisConfig } from '@app/redis/RedisConfig';

export const BULK_ACTION_CONFIG = Symbol('BULK_ACTION_CONFIG');

export interface BulkActionRedisConfig extends RedisConfig {
  keyPrefix?: string;
}

export interface FairQueueConfig {
  alpha: number;
}

export interface BackpressureConfig {
  globalRps: number;
  readyQueueMaxSize: number;
  rateLimitWindowSec: number;
  rateLimitKeyTtlSec: number;
  dispatchIntervalMs: number;
  dispatchBatchSize: number;
  defaultBackoffMs: number;
  maxBackoffMs: number;
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
}

export const DEFAULT_FAIR_QUEUE_CONFIG: FairQueueConfig = {
  alpha: 10000,
};

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  globalRps: 10000,
  readyQueueMaxSize: 10000,
  rateLimitWindowSec: 1,
  rateLimitKeyTtlSec: 2,
  dispatchIntervalMs: 100,
  dispatchBatchSize: 100,
  defaultBackoffMs: 1000,
  maxBackoffMs: 60000,
};
