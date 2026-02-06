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
import { RateLimiterService } from '@app/bulk-action/backpressure/RateLimiterService';

describe('RateLimiterService', () => {
  let module: TestingModule;
  let service: RateLimiterService;
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
      globalRps: 10,
      readyQueueMaxSize: 10000,
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
        RateLimiterService,
      ],
    }).compile();

    await module.init();

    service = module.get(RateLimiterService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('checkRateLimit', () => {
    it('RPS 이하의 요청은 모두 허용한다', async () => {
      // given & when
      const results = [];

      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        const result = await service.checkRateLimit('customer-A');
        results.push(result);
      }

      // then
      for (const result of results) {
        expect(result.allowed).toBe(true);
      }
    });

    it('RPS를 초과하면 거부한다', async () => {
      // given - 10건 허용
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await service.checkRateLimit('customer-A');
      }

      // when - 11번째
      const result = await service.checkRateLimit('customer-A');

      // then
      expect(result.allowed).toBe(false);
    });

    it('거부 시 카운터가 롤백되어 이전 카운트를 반환한다', async () => {
      // given
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await service.checkRateLimit('customer-A');
      }

      // when
      const result = await service.checkRateLimit('customer-A');

      // then
      expect(result.allowed).toBe(false);
      expect(result.globalCount).toBe(10);
      expect(result.globalLimit).toBe(10);
    });

    it('다른 윈도우에서는 카운트가 리셋된다', async () => {
      // given
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await service.checkRateLimit('customer-A');
      }

      // when - 1초 대기하여 새 윈도우 진입
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const result = await service.checkRateLimit('customer-A');

      // then
      expect(result.allowed).toBe(true);
      expect(result.globalCount).toBe(1);
    }, 10000);

    it('활성 고객사 수에 따라 per-group RPS가 분배된다', async () => {
      // given - globalRps=10, 고객사 A만 있을 때 10 RPS
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        const result = await service.checkRateLimit('customer-A');
        expect(result.allowed).toBe(true);
      }

      // when - 고객사 B 등록 (checkRateLimit 호출 시 active-groups에 자동 등록)
      await service.checkRateLimit('customer-B');

      // then - 고객사 A 6번째: per-group limit이 5로 줄었으므로 거부
      const result = await service.checkRateLimit('customer-A');
      expect(result.allowed).toBe(false);
      expect(result.perGroupLimit).toBe(5);
    });

    it('global limit에 먼저 걸리면 per-group과 무관하게 거부한다', async () => {
      // given - globalRps=10, 고객사 2개가 각각 5건씩 → 총 10건
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await service.checkRateLimit('customer-A');
      }

      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await service.checkRateLimit('customer-B');
      }

      // when - 11번째 요청 (고객사 C, per-group은 여유 있지만 global 초과)
      const result = await service.checkRateLimit('customer-C');

      // then
      expect(result.allowed).toBe(false);
    });
  });

  describe('deactivateGroup', () => {
    it('비활성화된 그룹은 active-groups에서 제거된다', async () => {
      // given
      await service.checkRateLimit('customer-A');
      await service.checkRateLimit('customer-B');

      // when
      await service.deactivateGroup('customer-A');

      // then
      const status = await service.getStatus('customer-B');
      expect(status.activeGroupCount).toBe(1);
    });
  });

  describe('getStatus', () => {
    it('현재 Rate Limit 상태를 조회한다', async () => {
      // given
      await service.checkRateLimit('customer-A');
      await service.checkRateLimit('customer-A');
      await service.checkRateLimit('customer-A');

      // when
      const status = await service.getStatus('customer-A');

      // then
      expect(status.globalCount).toBe(3);
      expect(status.globalLimit).toBe(10);
      expect(status.groupCount).toBe(3);
      expect(status.activeGroupCount).toBe(1);
      expect(status.perGroupLimit).toBe(10);
    });
  });
});
