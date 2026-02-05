import { DynamicModule, Module } from '@nestjs/common';
import { RedisConfig } from './RedisConfig';
import { REDIS_CONFIG, RedisService } from './RedisService';

@Module({})
export class RedisModule {
  static register(config: RedisConfig): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        {
          provide: REDIS_CONFIG,
          useValue: config,
        },
        RedisService,
      ],
      exports: [RedisService],
    };
  }
}
