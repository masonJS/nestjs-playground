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

export interface CongestionConfig {
  enabled: boolean;
  baseBackoffMs: number;
  maxBackoffMs: number;
  statsRetentionMs: number;
}

export interface WorkerPoolConfig {
  workerCount: number;
  fetchIntervalMs: number;
  fetchBatchSize: number;
  workerTimeoutSec: number;
  jobTimeoutMs: number;
  maxRetryCount: number;
  shutdownGracePeriodMs: number;
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
  backpressure: BackpressureConfig;
  congestion: CongestionConfig;
  workerPool: WorkerPoolConfig;
}

export const DEFAULT_FAIR_QUEUE_CONFIG: FairQueueConfig = {
  alpha: 10000, // 양수값
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

export const DEFAULT_CONGESTION_CONFIG: CongestionConfig = {
  enabled: true,
  baseBackoffMs: 1000,
  maxBackoffMs: 120000,
  statsRetentionMs: 3600000,
};

export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  workerCount: 10,
  fetchIntervalMs: 200,
  fetchBatchSize: 50,
  workerTimeoutSec: 5,
  jobTimeoutMs: 30000,
  maxRetryCount: 3,
  shutdownGracePeriodMs: 30000,
};
