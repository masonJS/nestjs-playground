import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { DistributedLockService } from '@app/bulk-action/lock/DistributedLockService';
import { AggregatorService } from '@app/bulk-action/aggregator/AggregatorService';
import { AGGREGATOR } from '@app/bulk-action/aggregator/AggregatorInterface';
import { DefaultAggregator } from '@app/bulk-action/aggregator/DefaultAggregator';
import { WatcherService } from '@app/bulk-action/watcher/WatcherService';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { GroupStatus } from '@app/bulk-action/model/job-group/type/GroupStatus';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('WatcherService', () => {
  let module: TestingModule;
  let service: WatcherService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  const config = createTestBulkActionConfig({
    watcher: {
      intervalMs: 60000, // 테스트 중 자동 실행 방지
      groupTimeoutMs: 1000, // 1초 타임아웃 (테스트용)
      staleGroupThresholdMs: 500,
      lockRetryCount: 0, // 락 획득 실패 시 즉시 포기 (테스트 속도)
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
        DistributedLockService,
        DefaultAggregator,
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator) => [defaultAgg],
          inject: [DefaultAggregator],
        },
        AggregatorService,
        WatcherService,
      ],
    }).compile();

    // init() 호출 시 WatcherService.onModuleInit() → start() 실행되므로
    // 수동 init 대신 개별 init 진행
    const luaLoader = module.get(LuaScriptLoader);
    await luaLoader.onModuleInit();

    service = module.get(WatcherService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);

    // 자동 start 방지 — 수동으로 watchCycle 호출
    service.stop();
  });

  afterAll(async () => {
    service.stop();
    await module.close();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  const GROUP_ID = 'watcher-group-1';

  async function setupJobResults(
    groupId: string,
    results: { jobId: string; success: boolean; durationMs: number }[],
  ) {
    for (const r of results) {
      await redisService.list.append(
        keys.groupJobResults(groupId),
        JSON.stringify(r),
      );
    }
  }

  describe('CREATED → DISPATCHED 전이', () => {
    it('registeredJobs >= totalJobs이면 DISPATCHED로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'CREATED',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'registeredJobs',
        '5',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('DISPATCHED');
    });

    it('registeredJobs < totalJobs이면 CREATED를 유지한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'CREATED',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'registeredJobs',
        '3',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('CREATED');
    });
  });

  describe('DISPATCHED → RUNNING 전이', () => {
    it('firstJobStartedAt가 양수이면 RUNNING으로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'DISPATCHED',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'firstJobStartedAt',
        Date.now().toString(),
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('RUNNING');
    });

    it('firstJobStartedAt가 0이면 DISPATCHED를 유지한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'DISPATCHED',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'firstJobStartedAt',
        '0',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('DISPATCHED');
    });
  });

  describe('RUNNING → AGGREGATING → COMPLETED 전이', () => {
    it('모든 Job이 완료되면 COMPLETED로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '3');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '2',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await setupJobResults(GROUP_ID, [
        { jobId: 'j1', success: true, durationMs: 100 },
        { jobId: 'j2', success: true, durationMs: 200 },
        { jobId: 'j3', success: false, durationMs: 50 },
      ]);
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('COMPLETED');

      const resultRaw = await redisService.hash.get(
        keys.groupResult(GROUP_ID),
        'result',
      );
      expect(resultRaw).not.toBeNull();
      const result = JSON.parse(resultRaw!);
      expect(result.successCount).toBe(2);
      expect(result.failedCount).toBe(1);
      expect(result.totalJobs).toBe(3);
      expect(result.failedJobIds).toEqual(['j3']);
    });

    it('미완료 Job이 존재하면 RUNNING을 유지한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '1',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('RUNNING');
    });
  });

  describe('AGGREGATING → COMPLETED 전이', () => {
    it('aggregationStartAt이 0이면 즉시 finalize하여 COMPLETED로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        GroupStatus.AGGREGATING,
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '2');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '1',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await setupJobResults(GROUP_ID, [
        { jobId: 'j1', success: true, durationMs: 100 },
        { jobId: 'j2', success: false, durationMs: 200 },
      ]);
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe(GroupStatus.COMPLETED);

      const resultRaw = await redisService.hash.get(
        keys.groupResult(GROUP_ID),
        'result',
      );
      expect(resultRaw).not.toBeNull();
      const result = JSON.parse(resultRaw!);
      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
    });

    it('stale aggregation이면 재시도하여 COMPLETED로 전이한다', async () => {
      // given — staleGroupThresholdMs=500 초과
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        GroupStatus.AGGREGATING,
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '2');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'successCount',
        '1',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'failedCount', '1');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'aggregationStartAt',
        (Date.now() - 1000).toString(),
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await setupJobResults(GROUP_ID, [
        { jobId: 'j1', success: true, durationMs: 150 },
        { jobId: 'j2', success: false, durationMs: 250 },
      ]);
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe(GroupStatus.COMPLETED);

      const resultRaw = await redisService.hash.get(
        keys.groupResult(GROUP_ID),
        'result',
      );
      expect(resultRaw).not.toBeNull();
    });

    it('최근 시작된 aggregation이면 AGGREGATING을 유지한다', async () => {
      // given — aggregationStartAt이 staleGroupThresholdMs(500) 이내
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        GroupStatus.AGGREGATING,
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'aggregationStartAt',
        Date.now().toString(),
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe(GroupStatus.AGGREGATING);
    });
  });

  describe('타임아웃 → FAILED 전이', () => {
    it('타임아웃된 그룹을 FAILED로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'RUNNING',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() - 1).toString(), // 이미 만료
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe('FAILED');
    });
  });

  describe('터미널 상태 감시 목록 제거', () => {
    it('COMPLETED 상태 그룹을 감시 목록에서 제거한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'COMPLETED',
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const members = await redisService.set.members(
        keys.watcherActiveGroups(),
      );
      expect(members).not.toContain(GROUP_ID);
    });

    it('FAILED 상태 그룹을 감시 목록에서 제거한다', async () => {
      // given
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'status', 'FAILED');
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const members = await redisService.set.members(
        keys.watcherActiveGroups(),
      );
      expect(members).not.toContain(GROUP_ID);
    });
  });

  describe('AGGREGATING 타임아웃 → FAILED 전이', () => {
    it('AGGREGATING 상태에서 타임아웃 시 FAILED로 전이한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        GroupStatus.AGGREGATING,
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() - 1).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      await service.watchCycle();

      // then
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe(GroupStatus.FAILED);
    });

    it('aggregationLock 선점 시 FAILED 전이를 건너뛴다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        GroupStatus.AGGREGATING,
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() - 1).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // 락 선점 — lockRetryCount=0이므로 acquire 즉시 실패
      const lockService = module.get(DistributedLockService);
      const lockKey = keys.groupAggregationLock(GROUP_ID);
      const token = await lockService.acquire(lockKey);
      expect(token).not.toBeNull();

      // when
      await service.watchCycle();

      // then — 락 획득 실패로 AGGREGATING 유지
      const meta = await redisService.hash.getAll(keys.groupMeta(GROUP_ID));
      expect(meta.status).toBe(GroupStatus.AGGREGATING);

      // cleanup
      await lockService.release(lockKey, token!);
    });
  });

  describe('getStats', () => {
    it('Watcher 통계를 반환한다', async () => {
      // given
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'status',
        'CREATED',
      );
      await redisService.hash.set(keys.groupMeta(GROUP_ID), 'totalJobs', '5');
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'registeredJobs',
        '5',
      );
      await redisService.hash.set(
        keys.groupMeta(GROUP_ID),
        'timeoutAt',
        (Date.now() + 60000).toString(),
      );
      await redisService.set.add(keys.watcherActiveGroups(), GROUP_ID);

      // when
      const statsBefore = service.getStats();
      await service.watchCycle();
      const statsAfter = service.getStats();

      // then
      expect(statsAfter.cycleCount).toBe(statsBefore.cycleCount + 1);
      expect(statsAfter.groupsChecked).toBeGreaterThan(
        statsBefore.groupsChecked,
      );
    });
  });
});
