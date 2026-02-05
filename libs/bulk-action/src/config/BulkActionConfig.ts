import { RedisConfig } from '@app/redis/RedisConfig';

export const BULK_ACTION_CONFIG = Symbol('BULK_ACTION_CONFIG');

export interface BulkActionRedisConfig extends RedisConfig {
  keyPrefix?: string;
}

export interface FairQueueConfig {
  alpha: number;
}

export interface BulkActionConfig {
  redis: BulkActionRedisConfig;
  fairQueue: FairQueueConfig;
}

export const DEFAULT_FAIR_QUEUE_CONFIG: FairQueueConfig = {
  alpha: 10000,
};
