import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { CongestionControlService } from '@app/bulk-action/congestion/CongestionControlService';
import { CongestionLevel } from '@app/bulk-action/congestion/BackoffCalculator';

describe('CongestionControlService', () => {
  let module: TestingModule;
  let service: CongestionControlService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

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
      ...DEFAULT_BACKPRESSURE_CONFIG,
      globalRps: 10,
    },
    congestion: {
      enabled: true,
      baseBackoffMs: 1000,
      maxBackoffMs: 120000,
      statsRetentionMs: 3600000,
    },
    workerPool: DEFAULT_WORKER_POOL_CONFIG,
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
        CongestionControlService,
      ],
    }).compile();

    await module.init();

    service = module.get(CongestionControlService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
    // active-groups에 customer-A 등록
    await redisService.set.add(keys.activeGroups(), 'customer-A');
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('addToNonReady', () => {
    it('첫 번째 작업은 base backoff를 받는다', async () => {
      // when
      const result = await service.addToNonReady('job-1', 'customer-A');

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.nonReadyCount).toBe(1);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);
    });

    it('작업이 쌓이면 backoff가 증가한다', async () => {
      // given - 10개 작업 추가 (rateLimitSpeed = globalRps/1group = 10)
      for (let i = 0; i < 10; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 11번째
      const result = await service.addToNonReady('job-10', 'customer-A');

      // then - backoff = 1000 + floor(11/10) * 1000 = 2000
      expect(result.backoffMs).toBe(2000);
      expect(result.nonReadyCount).toBe(11);
    });

    it('여러 활성 그룹이 있으면 rateLimitSpeed가 줄어들어 backoff가 증가한다', async () => {
      // given - 2개 그룹 등록
      await redisService.set.add(keys.activeGroups(), 'customer-B');

      // rateLimitSpeed = floor(10/2) = 5
      // 5개 작업 추가
      for (let i = 0; i < 5; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 6번째
      const result = await service.addToNonReady('job-5', 'customer-A');

      // then - backoff = 1000 + floor(6/5) * 1000 = 2000
      expect(result.backoffMs).toBe(2000);
      expect(result.rateLimitSpeed).toBe(5);
    });

    it('Non-ready Queue에 작업이 추가된다', async () => {
      // when
      await service.addToNonReady('job-1', 'customer-A');

      // then
      const size = await redisService.sortedSet.count(keys.nonReadyQueue());
      expect(size).toBe(1);
    });
  });

  describe('releaseFromNonReady', () => {
    it('카운터를 감소시킨다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');
      await service.addToNonReady('job-3', 'customer-A');

      // when
      const newCount = await service.releaseFromNonReady('customer-A', 2);

      // then
      expect(newCount).toBe(1);
    });

    it('카운터 감소 후 추가하면 backoff가 줄어든다', async () => {
      // given - 20개 작업
      for (let i = 0; i < 20; i++) {
        await service.addToNonReady(`job-${i}`, 'customer-A');
      }

      // when - 10개 해제 후 추가
      await service.releaseFromNonReady('customer-A', 10);
      const result = await service.addToNonReady('job-20', 'customer-A');

      // then - nonReadyCount = 10 + 1 = 11, backoff = 1000 + floor(11/10)*1000 = 2000
      expect(result.nonReadyCount).toBe(11);
      expect(result.backoffMs).toBe(2000);
    });
  });

  describe('getCongestionState', () => {
    it('그룹의 혼잡 상태를 조회한다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');

      // when
      const state = await service.getCongestionState('customer-A');

      // then
      expect(state.groupId).toBe('customer-A');
      expect(state.nonReadyCount).toBe(2);
      expect(state.rateLimitSpeed).toBe(10);
      expect(state.lastBackoffMs).toBe(1000);
    });
  });

  describe('getSystemCongestionSummary', () => {
    it('전체 시스템 혼잡 요약을 반환한다', async () => {
      // given
      await redisService.set.add(keys.activeGroups(), 'customer-B');
      await service.addToNonReady('job-A1', 'customer-A');
      await service.addToNonReady('job-B1', 'customer-B');

      // when
      const summary = await service.getSystemCongestionSummary();

      // then
      expect(summary.activeGroupCount).toBe(2);
      expect(summary.totalNonReadyCount).toBe(2);
      expect(summary.groups).toHaveLength(2);
    });
  });

  describe('resetGroupStats', () => {
    it('그룹의 혼잡 통계를 초기화한다', async () => {
      // given
      await service.addToNonReady('job-1', 'customer-A');
      await service.addToNonReady('job-2', 'customer-A');

      // when
      await service.resetGroupStats('customer-A');

      // then
      const state = await service.getCongestionState('customer-A');
      expect(state.nonReadyCount).toBe(0);
      expect(state.lastBackoffMs).toBe(0);
    });
  });

  describe('disabled mode', () => {
    it('disabled일 때 고정 backoff로 폴백한다', async () => {
      // given - disabled config로 새 모듈 생성
      const disabledConfig: BulkActionConfig = {
        ...config,
        congestion: {
          ...config.congestion,
          enabled: false,
        },
      };

      const disabledModule = await Test.createTestingModule({
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
            useValue: disabledConfig,
          },
          RedisKeyBuilder,
          LuaScriptLoader,
          CongestionControlService,
        ],
      }).compile();

      await disabledModule.init();
      const disabledService = disabledModule.get(CongestionControlService);

      // when
      const result = await disabledService.addToNonReady('job-1', 'customer-A');

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);

      // cleanup
      await disabledModule.close();
    });
  });
});
