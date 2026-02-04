import { DynamicModule, Module } from '@nestjs/common';
import { FairQueueService } from './fair-queue/FairQueueService';
import { LuaScriptLoader } from './lua/LuaScriptLoader';
import { redisProvider, BULK_ACTION_CONFIG } from './redis/RedisProvider';
import {
  BulkActionConfig,
  DEFAULT_FAIR_QUEUE_CONFIG,
  RedisConfig,
  FairQueueConfig,
} from './config/BulkActionConfig';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: RedisConfig } & { fairQueue?: Partial<FairQueueConfig> },
  ): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      redis: config.redis,
      fairQueue: {
        ...DEFAULT_FAIR_QUEUE_CONFIG,
        ...config.fairQueue,
      },
    };

    return {
      module: BulkActionModule,
      providers: [
        {
          provide: BULK_ACTION_CONFIG,
          useValue: mergedConfig,
        },
        redisProvider,
        LuaScriptLoader,
        FairQueueService,
      ],
      exports: [FairQueueService],
    };
  }
}
