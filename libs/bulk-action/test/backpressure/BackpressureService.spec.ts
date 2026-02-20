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
  DEFAULT_WORKER_POOL_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { RateLimiterService } from '@app/bulk-action/backpressure/RateLimiterService';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { NonReadyQueueService } from '@app/bulk-action/backpressure/NonReadyQueueService';
import { BackpressureService } from '@app/bulk-action/backpressure/BackpressureService';
import { CongestionControlService } from '@app/bulk-action/congestion/CongestionControlService';
import { Job } from '@app/bulk-action/model/job/Job';
import { JobStatus } from '@app/bulk-action/model/job/type/JobStatus';
import { BackpressureDestination } from '@app/bulk-action/backpressure/dto/BackpressureDto';

describe('BackpressureService', () => {
  let module: TestingModule;
  let backpressure: BackpressureService;
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
      globalRps: 5,
      readyQueueMaxSize: 10,
      rateLimitWindowSec: 10,
      rateLimitKeyTtlSec: 12,
      dispatchIntervalMs: 100,
      dispatchBatchSize: 100,
      defaultBackoffMs: 1000,
      maxBackoffMs: 60000,
    },
    congestion: DEFAULT_CONGESTION_CONFIG,
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
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        CongestionControlService,
        BackpressureService,
      ],
    }).compile();

    await module.init();

    backpressure = module.get(BackpressureService);
    readyQueue = module.get(ReadyQueueService);
    nonReadyQueue = module.get(NonReadyQueueService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('admit', () => {
    it('Rate Limit 이내의 작업은 Ready Queue로 들어간다', async () => {
      // given
      const job = createMockJob('job-001', 'customer-A');

      // when
      const result = await backpressure.admit(job);

      // then
      expect(result.accepted).toBe(true);
      expect(result.destination).toBe(BackpressureDestination.READY);
      expect(await readyQueue.size()).toBe(1);
    });

    it('Rate Limit 초과 작업은 Non-ready Queue로 들어간다', async () => {
      // given - 5건으로 RPS 소진
      for (let i = 0; i < 5; i++) {
        await backpressure.admit(createMockJob(`job-${i}`, 'customer-A'));
      }

      // when - 6번째
      const result = await backpressure.admit(
        createMockJob('job-5', 'customer-A'),
      );

      // then
      expect(result.accepted).toBe(true);
      expect(result.destination).toBe(BackpressureDestination.NON_READY);
      expect(result.reason).toContain('Rate limited');
      expect(await nonReadyQueue.size()).toBe(1);
    });

    it('Ready Queue가 가득 차면 rejected를 반환한다', async () => {
      // given - readyQueueMaxSize=10 직접 채우기
      for (let i = 0; i < 10; i++) {
        await readyQueue.push(`fill-${i}`);
      }

      // when
      const result = await backpressure.admit(
        createMockJob('job-overflow', 'customer-A'),
      );

      // then
      expect(result.accepted).toBe(false);
      expect(result.destination).toBe(BackpressureDestination.REJECTED);
    });

    it('다른 고객사 간 Rate Limit이 분배된다', async () => {
      // given - globalRps=5, 고객사 2개 → 각 2 RPS (floor(5/2))
      // 고객사 A: 2건
      await backpressure.admit(createMockJob('A-1', 'customer-A'));
      await backpressure.admit(createMockJob('A-2', 'customer-A'));

      // 고객사 B 등록
      await backpressure.admit(createMockJob('B-1', 'customer-B'));

      // when - 고객사 A 3번째 (per-group limit 초과)
      const result = await backpressure.admit(
        createMockJob('A-3', 'customer-A'),
      );

      // then
      expect(result.destination).toBe(BackpressureDestination.NON_READY);
    });
  });

  describe('requeue', () => {
    it('실패한 작업을 Non-ready Queue에 재등록한다', async () => {
      // when
      await backpressure.requeue('job-fail', 'customer-A');

      // then
      expect(await nonReadyQueue.size()).toBe(1);
    });

    it('여러 작업 requeue 시 Non-ready Queue에 모두 등록된다', async () => {
      // when
      await backpressure.requeue('job-fail-0', 'customer-A');
      await backpressure.requeue('job-fail-3', 'customer-A');

      // then
      expect(await nonReadyQueue.size()).toBe(2);
    });
  });
});

function createMockJob(id: string, groupId: string): Job {
  return {
    id,
    groupId,
    processorType: 'TEST',
    payload: {},
    status: JobStatus.PENDING,
    retryCount: 0,
    createdAt: Date.now(),
  };
}
