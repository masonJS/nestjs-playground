import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_FAIR_QUEUE_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';

describe('ReadyQueueService', () => {
  let module: TestingModule;
  let service: ReadyQueueService;
  let redisService: RedisService;

  const KEY_PREFIX = 'test:';
  const env = Configuration.getEnv();

  const config: BulkActionConfig = {
    redis: {
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      db: env.redis.db,
      keyPrefix: KEY_PREFIX,
    },
    fairQueue: DEFAULT_FAIR_QUEUE_CONFIG,
    backpressure: {
      globalRps: 10000,
      readyQueueMaxSize: 3,
      rateLimitWindowSec: 1,
      rateLimitKeyTtlSec: 2,
      dispatchIntervalMs: 100,
      dispatchBatchSize: 100,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
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
          useValue: config,
        },
        RedisKeyBuilder,
        LuaScriptLoader,
        ReadyQueueService,
      ],
    }).compile();

    await module.init();

    service = module.get(ReadyQueueService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('push', () => {
    it('작업을 Ready Queue에 추가한다', async () => {
      // when
      const result = await service.push('job-1');

      // then
      expect(result).toBe(true);
      expect(await service.size()).toBe(1);
    });

    it('maxSize에 도달하면 false를 반환한다', async () => {
      // given - maxSize=3 채우기
      await service.push('job-1');
      await service.push('job-2');
      await service.push('job-3');

      // when
      const result = await service.push('job-4');

      // then
      expect(result).toBe(false);
      expect(await service.size()).toBe(3);
    });
  });

  describe('pop', () => {
    it('FIFO 순서로 작업을 꺼낸다', async () => {
      // given
      await service.push('job-1');
      await service.push('job-2');

      // when
      const first = await service.pop();
      const second = await service.pop();

      // then
      expect(first).toBe('job-1');
      expect(second).toBe('job-2');
    });

    it('큐가 비어있으면 null을 반환한다', async () => {
      // when
      const result = await service.pop();

      // then
      expect(result).toBeNull();
    });
  });

  describe('hasCapacity', () => {
    it('여유가 있으면 true를 반환한다', async () => {
      // given
      await service.push('job-1');

      // when & then
      expect(await service.hasCapacity()).toBe(true);
    });

    it('maxSize에 도달하면 false를 반환한다', async () => {
      // given
      await service.push('job-1');
      await service.push('job-2');
      await service.push('job-3');

      // when & then
      expect(await service.hasCapacity()).toBe(false);
    });
  });

  describe('size', () => {
    it('현재 큐 크기를 반환한다', async () => {
      // given
      await service.push('job-1');
      await service.push('job-2');

      // when & then
      expect(await service.size()).toBe(2);
    });
  });
});
