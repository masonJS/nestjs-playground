import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { ReliableQueueService } from '@app/bulk-action/reliable-queue/ReliableQueueService';
import { OrphanRecoveryService } from '@app/bulk-action/reliable-queue/OrphanRecoveryService';
import { AggregatorService } from '@app/bulk-action/aggregator/AggregatorService';
import { FairQueueService } from '@app/bulk-action/fair-queue/FairQueueService';
import { DistributedLockService } from '@app/bulk-action/lock/DistributedLockService';
import { AGGREGATOR } from '@app/bulk-action/aggregator/AggregatorInterface';
import { DefaultAggregator } from '@app/bulk-action/aggregator/DefaultAggregator';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('OrphanRecoveryService', () => {
  let module: TestingModule;
  let service: OrphanRecoveryService;
  let reliableQueue: ReliableQueueService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  const config = createTestBulkActionConfig({
    reliableQueue: {
      ackTimeoutMs: 100,
      orphanRecoveryIntervalMs: 60000, // 자동 실행 방지
      maxRetryCount: 2,
    },
  });

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
        { provide: BULK_ACTION_CONFIG, useValue: config },
        RedisKeyBuilder,
        LuaScriptLoader,
        ReliableQueueService,
        OrphanRecoveryService,
        AggregatorService,
        FairQueueService,
        DistributedLockService,
        DefaultAggregator,
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator) => [defaultAgg],
          inject: [DefaultAggregator],
        },
      ],
    }).compile();

    // OnModuleInit에서 orphan recovery가 시작되므로 즉시 중지
    await module.init();

    service = module.get(OrphanRecoveryService);
    reliableQueue = module.get(ReliableQueueService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);

    service.stop();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    service.stop();
    await redisService.flushDatabase();
    await module.close();
  });

  async function seedJob(
    jobId: string,
    groupId: string,
    retryCount = 0,
  ): Promise<void> {
    await redisService.hash.set(keys.job(jobId), 'id', jobId);
    await redisService.hash.set(keys.job(jobId), 'groupId', groupId);
    await redisService.hash.set(
      keys.job(jobId),
      'retryCount',
      retryCount.toString(),
    );
    await redisService.hash.set(keys.job(jobId), 'processorType', 'TEST');
    await redisService.hash.set(keys.job(jobId), 'payload', '{}');
    await redisService.hash.set(keys.job(jobId), 'status', 'PENDING');
    await redisService.hash.set(keys.job(jobId), 'createdAt', '0');
    await redisService.list.append(keys.readyQueue(), jobId);
  }

  async function seedGroupMeta(
    groupId: string,
    totalJobs: number,
  ): Promise<void> {
    await redisService.hash.set(
      keys.groupMeta(groupId),
      'totalJobs',
      totalJobs.toString(),
    );
    await redisService.hash.set(keys.groupMeta(groupId), 'doneJobs', '0');
    await redisService.hash.set(keys.groupMeta(groupId), 'status', 'RUNNING');
    await redisService.hash.set(keys.groupMeta(groupId), 'successCount', '0');
    await redisService.hash.set(keys.groupMeta(groupId), 'failedCount', '0');
  }

  describe('runOnce', () => {
    it('타임아웃된 작업을 Ready Queue로 복구한다', async () => {
      // given
      await seedJob('job-001', 'group-A');
      await reliableQueue.dequeue('worker-0');

      // ackTimeout이 지나도록 대기
      await new Promise((resolve) => setTimeout(resolve, 200));

      // when
      const result = await service.runOnce();

      // then
      expect(result.recovered).toBe(1);
      expect(result.deadLettered).toBe(0);

      // Ready Queue에 복구되어야 함
      const readyQueueSize = await redisService.list.length(keys.readyQueue());
      expect(readyQueueSize).toBe(1);

      // In-flight Queue는 비어야 함
      const inFlightSize = await redisService.sortedSet.count(
        keys.inFlightQueue(),
      );
      expect(inFlightSize).toBe(0);

      // retryCount가 증가해야 함
      const retryCount = await redisService.hash.get(
        keys.job('job-001'),
        'retryCount',
      );
      expect(retryCount).toBe('1');
    });

    it('maxRetry 초과 시 DLQ로 이동하고 집계를 수행한다', async () => {
      // given — retryCount가 이미 maxRetryCount(2)에 도달
      await seedJob('job-002', 'group-B', 2);
      await seedGroupMeta('group-B', 1);
      await reliableQueue.dequeue('worker-0');

      await new Promise((resolve) => setTimeout(resolve, 200));

      // when
      const result = await service.runOnce();

      // then
      expect(result.recovered).toBe(0);
      expect(result.deadLettered).toBe(1);

      // DLQ에 존재해야 함
      const dlqSize = await redisService.list.length(keys.deadLetterQueue());
      expect(dlqSize).toBe(1);

      // Job 상태: recover-orphans.lua가 FAILED로 설정 후 fairQueue.ack이 COMPLETED로 변경
      // (ack.lua가 항상 COMPLETED로 설정하는 기존 동작)
      const status = await redisService.hash.get(keys.job('job-002'), 'status');
      expect(status).toBe('COMPLETED');
    });

    it('만료되지 않은 작업은 건드리지 않는다', async () => {
      // given — ackTimeout이 5초인 작업 (아직 만료 안 됨)
      await seedJob('job-003', 'group-C');
      await reliableQueue.dequeue('worker-0');

      // when — 즉시 실행 (타임아웃 전)
      const result = await service.runOnce();

      // then
      expect(result.recovered).toBe(0);
      expect(result.deadLettered).toBe(0);

      // In-flight에 여전히 존재
      const inFlightSize = await redisService.sortedSet.count(
        keys.inFlightQueue(),
      );
      expect(inFlightSize).toBe(1);
    });
  });

  describe('getStats', () => {
    it('누적 통계를 반환한다', async () => {
      // given
      await seedJob('job-004', 'group-D');
      await reliableQueue.dequeue('worker-0');
      await new Promise((resolve) => setTimeout(resolve, 200));

      // when
      await service.runOnce();
      const stats = service.getStats();

      // then
      expect(stats.totalCycles).toBeGreaterThanOrEqual(1);
      expect(stats.totalRecovered).toBeGreaterThanOrEqual(1);
    });
  });
});
