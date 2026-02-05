import { DynamicModule, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis/RedisModule';
import { FairQueueService } from './fair-queue/FairQueueService';
import { LuaScriptLoader } from './lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  BulkActionRedisConfig,
  DEFAULT_FAIR_QUEUE_CONFIG,
  FairQueueConfig,
} from './config/BulkActionConfig';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: BulkActionRedisConfig } & {
      fairQueue?: Partial<FairQueueConfig>;
    },
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
        LuaScriptLoader,
        FairQueueService,
      ],
      exports: [FairQueueService],
    };
  }
}
