import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { DistributedLockService } from '@app/bulk-action/lock/DistributedLockService';
import { AggregatorService } from '@app/bulk-action/aggregator/AggregatorService';
import { AGGREGATOR } from '@app/bulk-action/aggregator/AggregatorInterface';
import { DefaultAggregator } from '@app/bulk-action/aggregator/DefaultAggregator';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('AggregatorService', () => {
  let module: TestingModule;
  let service: AggregatorService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  const config = createTestBulkActionConfig();

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
        DistributedLockService,
        DefaultAggregator,
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator) => [defaultAgg],
          inject: [DefaultAggregator],
        },
        AggregatorService,
      ],
    }).compile();

    await module.init();

    service = module.get(AggregatorService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  const GROUP_ID = 'group-1';

  describe('recordJobResult', () => {
    it('successCount를 증가시킨다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '3');

      // when
      const result = await service.recordJobResult({
        jobId: 'job-1',
        groupId: GROUP_ID,
        success: true,
        durationMs: 100,
        processorType: 'email',
      });

      // then
      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.isGroupComplete).toBe(false);
    });

    it('failedCount를 증가시킨다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '3');

      // when
      const result = await service.recordJobResult({
        jobId: 'job-1',
        groupId: GROUP_ID,
        success: false,
        durationMs: 50,
        processorType: 'email',
        error: { message: 'fail', retryable: false },
      });

      // then
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.isGroupComplete).toBe(false);
    });

    it('마지막 Job 완료 시 isGroupComplete=true를 반환한다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '2');

      await service.recordJobResult({
        jobId: 'job-1',
        groupId: GROUP_ID,
        success: true,
        durationMs: 100,
      });

      // when
      const result = await service.recordJobResult({
        jobId: 'job-2',
        groupId: GROUP_ID,
        success: false,
        durationMs: 200,
        error: { message: 'err', retryable: false },
      });

      // then
      expect(result.isGroupComplete).toBe(true);
      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.totalJobs).toBe(2);
    });
  });

  describe('aggregate', () => {
    it('Job 결과를 집계하여 최종 결과를 생성한다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '3');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '2',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');

      await redisService.list.append(
        keys.groupJobResults(GROUP_ID),
        JSON.stringify({ jobId: 'j1', success: true, durationMs: 100 }),
      );
      await redisService.list.append(
        keys.groupJobResults(GROUP_ID),
        JSON.stringify({ jobId: 'j2', success: true, durationMs: 200 }),
      );
      await redisService.list.append(
        keys.groupJobResults(GROUP_ID),
        JSON.stringify({
          jobId: 'j3',
          success: false,
          durationMs: 50,
          error: 'fail',
        }),
      );

      // when
      const result = await service.aggregate(GROUP_ID);

      // then
      const typed = result as {
        successCount: number;
        failedCount: number;
        totalJobs: number;
        averageDurationMs: number;
        failedJobIds: string[];
      };

      expect(typed.successCount).toBe(2);
      expect(typed.failedCount).toBe(1);
      expect(typed.totalJobs).toBe(3);
      expect(typed.averageDurationMs).toBe(116); // (100+200+50)/3 = 116.66 → 116
      expect(typed.failedJobIds).toContain('j3');

      // verify stored
      const stored = await service.getResult(GROUP_ID);
      expect(stored).toEqual(typed);
    });
  });

  describe('getProgress', () => {
    it('실시간 진행률을 반환한다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '10');
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'doneJobs', '3');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '2',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );

      // when
      const progress = await service.getProgress(GROUP_ID);

      // then
      expect(progress.totalJobs).toBe(10);
      expect(progress.doneJobs).toBe(3);
      expect(progress.successCount).toBe(2);
      expect(progress.failedCount).toBe(1);
      expect(progress.progressPercent).toBe(30);
      expect(progress.status).toBe('RUNNING');
    });
  });

  describe('transition', () => {
    it('올바른 상태 전이를 수행한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );

      // when
      const result = await service.transition(
        GROUP_ID,
        'RUNNING' as any,
        'AGGREGATING' as any,
      );

      // then
      expect(result).toBe(true);

      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('AGGREGATING');
      expect(meta.aggregationStartAt).toBeDefined();
    });

    it('상태 불일치 시 전이를 거부한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );

      // when
      const result = await service.transition(
        GROUP_ID,
        'CREATED' as any,
        'DISPATCHED' as any,
      );

      // then
      expect(result).toBe(false);

      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('RUNNING');
    });
  });
});
