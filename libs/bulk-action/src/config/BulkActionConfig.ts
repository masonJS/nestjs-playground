export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export interface FairQueueConfig {
  alpha: number;
}

export interface BulkActionConfig {
  redis: RedisConfig;
  fairQueue: FairQueueConfig;
}

export const DEFAULT_FAIR_QUEUE_CONFIG: FairQueueConfig = {
  alpha: 10000,
};
