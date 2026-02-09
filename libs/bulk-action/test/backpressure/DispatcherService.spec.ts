import { setTimeout } from 'timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import {
  NonReadyQueueService,
  NonReadyReason,
} from '@app/bulk-action/backpressure/NonReadyQueueService';
import { DispatcherService } from '@app/bulk-action/backpressure/DispatcherService';

describe('DispatcherService', () => {
  let module: TestingModule;
  let dispatcher: DispatcherService;
  let readyQueue: ReadyQueueService;
  let nonReadyQueue: NonReadyQueueService;
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
      readyQueueMaxSize: 100,
      rateLimitWindowSec: 1,
      rateLimitKeyTtlSec: 2,
      dispatchIntervalMs: 50,
      dispatchBatchSize: 10,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
    congestion: DEFAULT_CONGESTION_CONFIG,
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
        NonReadyQueueService,
        DispatcherService,
      ],
    }).compile();

    await module.init();

    dispatcher = module.get(DispatcherService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redisService = module.get(RedisService);

    // 자동 시작 방지
    dispatcher.stop();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    dispatcher.stop();
    await redisService.flushDatabase();
    await module.close();
  });

  describe('dispatchOnce', () => {
    it('backoff 만료된 작업이 Ready Queue로 이동한다', async () => {
      // given - backoff 0ms (즉시 이동 가능)
      await nonReadyQueue.push('job-001', 0, NonReadyReason.RATE_LIMITED);
      await nonReadyQueue.push('job-002', 0, NonReadyReason.RATE_LIMITED);
      await setTimeout(10);

      // when
      const moved = await dispatcher.dispatchOnce();

      // then
      expect(moved).toBe(2);
      expect(await readyQueue.size()).toBe(2);
      expect(await nonReadyQueue.size()).toBe(0);
    });

    it('backoff 미만료 작업은 Non-ready Queue에 남는다', async () => {
      // given - 10초 후 만료
      await nonReadyQueue.push('job-001', 10000, NonReadyReason.RATE_LIMITED);

      // when
      const moved = await dispatcher.dispatchOnce();

      // then
      expect(moved).toBe(0);
      expect(await nonReadyQueue.size()).toBe(1);
      expect(await readyQueue.size()).toBe(0);
    });

    it('dispatchBatchSize만큼만 이동한다', async () => {
      // given - batchSize=10보다 많은 15개
      for (let i = 0; i < 15; i++) {
        // eslint-disable-next-line no-await-in-loop
        await nonReadyQueue.push(`job-${i}`, 0, NonReadyReason.RATE_LIMITED);
      }
      await setTimeout(10);

      // when
      const moved = await dispatcher.dispatchOnce();

      // then
      expect(moved).toBe(10);
      expect(await readyQueue.size()).toBe(10);
      expect(await nonReadyQueue.size()).toBe(5);
    });

    it('Ready Queue가 가득 차면 이동하지 않는다', async () => {
      // given - readyQueueMaxSize=100 채우기
      for (let i = 0; i < 100; i++) {
        // eslint-disable-next-line no-await-in-loop
        await readyQueue.push(`ready-${i}`);
      }
      await nonReadyQueue.push('job-001', 0, NonReadyReason.RATE_LIMITED);
      await setTimeout(10);

      // when
      const moved = await dispatcher.dispatchOnce();

      // then
      expect(moved).toBe(0);
      expect(await nonReadyQueue.size()).toBe(1);
    });

    it('Non-ready Queue가 비어있으면 0을 반환한다', async () => {
      // when
      const moved = await dispatcher.dispatchOnce();

      // then
      expect(moved).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('start 후 주기적으로 dispatch가 실행된다', async () => {
      // given
      await nonReadyQueue.push('job-001', 0, NonReadyReason.RATE_LIMITED);
      await setTimeout(10);

      // when
      dispatcher.start();
      await setTimeout(150);
      dispatcher.stop();

      // then
      expect(await readyQueue.size()).toBe(1);
      expect(await nonReadyQueue.size()).toBe(0);
    });
  });
});
