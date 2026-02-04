import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { BulkActionConfig } from '../config/BulkActionConfig';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const BULK_ACTION_CONFIG = Symbol('BULK_ACTION_CONFIG');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: BulkActionConfig): Redis =>
    new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    }),
  inject: [BULK_ACTION_CONFIG],
};
