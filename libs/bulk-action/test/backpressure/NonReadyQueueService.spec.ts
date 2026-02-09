import { setTimeout } from 'node:timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import {
  NonReadyQueueService,
  NonReadyReason,
} from '@app/bulk-action/backpressure/NonReadyQueueService';

describe('NonReadyQueueService', () => {
  let module: TestingModule;
  let service: NonReadyQueueService;
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
      readyQueueMaxSize: 10000,
      rateLimitWindowSec: 1,
      rateLimitKeyTtlSec: 2,
      dispatchIntervalMs: 100,
      dispatchBatchSize: 100,
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
        NonReadyQueueService,
      ],
    }).compile();

    await module.init();

    service = module.get(NonReadyQueueService);
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
    it('작업을 Non-ready Queue에 추가한다', async () => {
      // when
      await service.push('job-1', 1000, NonReadyReason.RATE_LIMITED);

      // then
      expect(await service.size()).toBe(1);
    });

    it('backoffMs가 maxBackoffMs를 초과하면 클램핑한다', async () => {
      // when
      await service.push('job-1', 999999, NonReadyReason.RATE_LIMITED);

      // then - maxBackoffMs=60000으로 클램핑되어 아직 만료 안됨
      const jobs = await service.peekReady(1);
      expect(jobs).toHaveLength(0);

      expect(await service.size()).toBe(1);
    });
  });

  describe('pushWithExponentialBackoff', () => {
    it('retryCount에 따라 지수 백오프가 적용된다', async () => {
      // when - retryCount=0 → backoff=1000ms
      await service.pushWithExponentialBackoff(
        'job-0',
        0,
        NonReadyReason.TRANSIENT_ERROR,
      );
      // retryCount=2 → backoff=4000ms
      await service.pushWithExponentialBackoff(
        'job-2',
        2,
        NonReadyReason.TRANSIENT_ERROR,
      );

      // then
      expect(await service.size()).toBe(2);
    });
  });

  describe('peekReady / popReady', () => {
    it('backoff 만료된 작업을 조회한다', async () => {
      // given - backoff 0ms (즉시 만료)
      await service.push('job-1', 0, NonReadyReason.RATE_LIMITED);
      await setTimeout(10);

      // when
      const jobs = await service.peekReady(10);

      // then
      expect(jobs).toEqual(['job-1']);
      // peek은 제거하지 않음
      expect(await service.size()).toBe(1);
    });

    it('backoff 미만료 작업은 조회되지 않는다', async () => {
      // given - backoff 10초
      await service.push('job-1', 10000, NonReadyReason.RATE_LIMITED);

      // when
      const jobs = await service.peekReady(10);

      // then
      expect(jobs).toHaveLength(0);
    });

    it('popReady로 만료된 작업을 제거하고 반환한다', async () => {
      // given
      await service.push('job-1', 0, NonReadyReason.RATE_LIMITED);
      await service.push('job-2', 0, NonReadyReason.RATE_LIMITED);
      await setTimeout(10);

      // when
      const jobs = await service.popReady(10);

      // then
      expect(jobs).toHaveLength(2);
      expect(await service.size()).toBe(0);
    });
  });

  describe('remove', () => {
    it('특정 작업을 제거한다', async () => {
      // given
      await service.push('job-1', 1000, NonReadyReason.RATE_LIMITED);
      await service.push('job-2', 1000, NonReadyReason.RATE_LIMITED);

      // when
      await service.remove('job-1');

      // then
      expect(await service.size()).toBe(1);
    });
  });
});
