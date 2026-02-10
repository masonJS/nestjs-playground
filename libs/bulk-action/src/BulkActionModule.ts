import { DynamicModule, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis/RedisModule';
import { BackpressureService } from './backpressure/BackpressureService';
import { DispatcherService } from './backpressure/DispatcherService';
import { NonReadyQueueService } from './backpressure/NonReadyQueueService';
import { RateLimiterService } from './backpressure/RateLimiterService';
import { ReadyQueueService } from './backpressure/ReadyQueueService';
import {
  BackpressureConfig,
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  BulkActionRedisConfig,
  CongestionConfig,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
  FairQueueConfig,
  WorkerPoolConfig,
} from './config/BulkActionConfig';
import { CongestionControlService } from './congestion/CongestionControlService';
import { CongestionStatsService } from './congestion/CongestionStatsService';
import { FairQueueService } from './fair-queue/FairQueueService';
import { RedisKeyBuilder } from './key/RedisKeyBuilder';
import { LuaScriptLoader } from './lua/LuaScriptLoader';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: BulkActionRedisConfig } & {
      fairQueue?: Partial<FairQueueConfig>;
      backpressure?: Partial<BackpressureConfig>;
      congestion?: Partial<CongestionConfig>;
      workerPool?: Partial<WorkerPoolConfig>;
    },
  ): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      redis: config.redis,
      fairQueue: {
        ...DEFAULT_FAIR_QUEUE_CONFIG,
        ...config.fairQueue,
      },
      backpressure: {
        ...DEFAULT_BACKPRESSURE_CONFIG,
        ...config.backpressure,
      },
      congestion: {
        ...DEFAULT_CONGESTION_CONFIG,
        ...config.congestion,
      },
      workerPool: {
        ...DEFAULT_WORKER_POOL_CONFIG,
        ...config.workerPool,
      },
    };

    return {
      module: BulkActionModule,
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        {
          provide: BULK_ACTION_CONFIG,
          useValue: mergedConfig,
        },
        RedisKeyBuilder,
        LuaScriptLoader,
        FairQueueService,
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        DispatcherService,
        BackpressureService,
        CongestionControlService,
        CongestionStatsService,
      ],
      exports: [
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        CongestionControlService,
      ],
    };
  }
}
