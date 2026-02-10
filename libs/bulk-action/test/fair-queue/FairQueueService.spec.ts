import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { FairQueueService } from '@app/bulk-action/fair-queue/FairQueueService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_CONGESTION_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';
import { JobStatus } from '@app/bulk-action/model/Job';
import { PriorityLevel, JobGroupHash } from '@app/bulk-action/model/JobGroup';
import { expectNonNullable } from '../../../web-common/test/unit/expectNonNullable';

describe('FairQueueService', () => {
  let module: TestingModule;
  let service: FairQueueService;
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
    fairQueue: {
      alpha: 10000,
    },
    backpressure: DEFAULT_BACKPRESSURE_CONFIG,
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
        FairQueueService,
      ],
    }).compile();

    await module.init();

    service = module.get(FairQueueService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('enqueue', () => {
    it('작업 데이터가 Redis에 저장된다', async () => {
      // given
      const groupId = 'group-1';
      const jobId = 'job-1';
      const payload = { action: 'SEND_EMAIL', target: 'user@test.com' };

      // when
      await service.enqueue({
        groupId,
        jobId,
        type: 'SEND_PROMOTION',
        payload,
      });

      // then
      const result = await redisService.hash.getAll(
        `${KEY_PREFIX}job:${jobId}`,
      );
      expect(result.id).toBe(jobId);
      expect(result.groupId).toBe(groupId);
      expect(result.type).toBe('SEND_PROMOTION');
      expect(JSON.parse(result.payload)).toEqual(payload);
      expect(result.status).toBe(JobStatus.PENDING);
      expect(Number(result.createdAt)).toBeGreaterThan(0);
    });

    it('그룹 작업 목록에 jobId가 추가된다', async () => {
      // when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
      });
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-2',
        type: 'SEND',
        payload: {},
      });

      // then
      const result = await redisService.list.range(
        `${KEY_PREFIX}group:group-1:jobs`,
        0,
        -1,
      );
      expect(result).toEqual(['job-1', 'job-2']);
    });

    it('그룹 메타데이터가 생성된다', async () => {
      // when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
        basePriority: 100,
        priorityLevel: PriorityLevel.HIGH,
      });

      // then
      const result = (await redisService.hash.getAll(
        `${KEY_PREFIX}group:group-1:meta`,
      )) as unknown as JobGroupHash;
      expect(result.totalJobs).toBe('1');
      expect(result.doneJobs).toBe('0');
      expect(result.basePriority).toBe('100');
      expect(result.priorityLevel).toBe('high');
      expect(result.status).toBe('CREATED');
    });

    it('같은 그룹에 작업 추가 시 totalJobs가 증가한다', async () => {
      // when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
      });
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-2',
        type: 'SEND',
        payload: {},
      });

      // then
      const result = await redisService.hash.get(
        `${KEY_PREFIX}group:group-1:meta`,
        'totalJobs',
      );
      expect(result).toBe('2');
    });

    it('그룹이 해당 priority 큐의 sorted set에 등록된다', async () => {
      // when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.HIGH,
      });

      // then
      const result = await redisService.sortedSet.range(
        `${KEY_PREFIX}fair-queue:high`,
        0,
        -1,
      );
      expect(result).toEqual(['group-1']);
    });

    it('서로 다른 priority 큐에 그룹이 분리된다', async () => {
      // when
      await service.enqueue({
        groupId: 'group-high',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.HIGH,
      });
      await service.enqueue({
        groupId: 'group-low',
        jobId: 'job-2',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.LOW,
      });

      // then
      const result = await service.getQueueStats();
      expect(result.highPriorityGroups).toBe(1);
      expect(result.normalPriorityGroups).toBe(0);
      expect(result.lowPriorityGroups).toBe(1);
    });
  });

  describe('enqueue → dequeue', () => {
    it('enqueue한 작업을 dequeue로 꺼낼 수 있다', async () => {
      // given
      const payload = { message: 'hello' };
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload,
      });

      // when
      const result = await service.dequeue();

      // then
      expectNonNullable(result);
      expect(result.id).toBe('job-1');
      expect(result.groupId).toBe('group-1');
      expect(result.type).toBe('SEND');
      expect(JSON.parse(result.payload)).toEqual(payload);
      expect(result.status).toBe(JobStatus.PROCESSING);
    });

    it('HIGH 그룹이 NORMAL보다 먼저 dequeue된다', async () => {
      // given
      await service.enqueue({
        groupId: 'group-normal',
        jobId: 'job-normal',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.NORMAL,
      });
      await service.enqueue({
        groupId: 'group-high',
        jobId: 'job-high',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.HIGH,
      });

      // when
      const first = await service.dequeue();
      const second = await service.dequeue();

      // then
      expectNonNullable(first);
      expectNonNullable(second);
      expect(first.id).toBe('job-high');
      expect(second.id).toBe('job-normal');
    });

    it('큐가 비어있으면 null을 반환한다', async () => {
      // when
      const result = await service.dequeue();

      // then
      expect(result).toBeNull();
    });
  });

  describe('공정 분배', () => {
    it('ack으로 doneJobs가 증가하면 sjfBoost가 적용되어 그룹이 전환된다', async () => {
      // given - 두 그룹에 각 3개 작업
      await enqueueJob('group-A', 'A-1');
      await enqueueJob('group-A', 'A-2');
      await enqueueJob('group-A', 'A-3');
      await enqueueJob('group-B', 'B-1');
      await enqueueJob('group-B', 'B-2');
      await enqueueJob('group-B', 'B-3');

      // when - dequeue + ack 반복
      const first = await service.dequeue();
      expectNonNullable(first);
      await service.ack(first.id, first.groupId);
      const firstGroup = first.groupId;

      const second = await service.dequeue();
      expectNonNullable(second);
      await service.ack(second.id, second.groupId);

      const third = await service.dequeue();
      expectNonNullable(third);

      // then
      // 첫 두 작업은 같은 그룹에서 나온다 (두 번째 dequeue에서 sjfBoost 재계산)
      expect(second.groupId).toBe(firstGroup);
      // 세 번째 작업은 다른 그룹에서 나온다 (sjfBoost 적용으로 그룹 전환)
      expect(third.groupId).not.toBe(firstGroup);
    });

    it('dequeue+ack 후 sorted set에서 해당 그룹의 순서가 하락한다', async () => {
      // given - 두 그룹에 각 3개 작업
      await enqueueJob('group-A', 'A-1');
      await enqueueJob('group-A', 'A-2');
      await enqueueJob('group-A', 'A-3');
      await enqueueJob('group-B', 'B-1');
      await enqueueJob('group-B', 'B-2');
      await enqueueJob('group-B', 'B-3');

      // when - 첫 번째 dequeue + ack
      const first = await service.dequeue();
      expectNonNullable(first);
      const firstGroup = first.groupId;
      const otherGroup = firstGroup === 'group-A' ? 'group-B' : 'group-A';
      await service.ack(first.id, first.groupId);

      // 두 번째 dequeue 시 doneJobs=1이 반영되어 sjfBoost 재계산
      await service.dequeue();

      // then - sjfBoost로 인해 firstGroup이 sorted set에서 뒤로 밀린다
      const result = await redisService.sortedSet.range(
        `${KEY_PREFIX}fair-queue:normal`,
        0,
        -1,
      );
      expect(result[0]).toBe(otherGroup);
    });

    it('세 그룹의 작업이 dequeue+ack 사이클로 모두 처리된다', async () => {
      // given
      await enqueueJob('group-A', 'group-A-1');
      await enqueueJob('group-A', 'group-A-2');
      await enqueueJob('group-A', 'group-A-3');
      await enqueueJob('group-B', 'group-B-1');
      await enqueueJob('group-B', 'group-B-2');
      await enqueueJob('group-B', 'group-B-3');
      await enqueueJob('group-C', 'group-C-1');
      await enqueueJob('group-C', 'group-C-2');
      await enqueueJob('group-C', 'group-C-3');

      // when - 9개 작업을 모두 dequeue + ack
      const jobs = [];

      for (let i = 0; i < 9; i++) {
        const job = await service.dequeue();
        expectNonNullable(job);
        await service.ack(job.id, job.groupId);
        jobs.push(job);
      }

      // then - 각 그룹이 3개씩 처리된다
      const countByGroup = new Map<string, number>();

      for (const job of jobs) {
        const count = countByGroup.get(job.groupId) ?? 0;
        countByGroup.set(job.groupId, count + 1);
      }
      expect(countByGroup.get('group-A')).toBe(3);
      expect(countByGroup.get('group-B')).toBe(3);
      expect(countByGroup.get('group-C')).toBe(3);

      // 모두 처리 후 큐가 비어있다
      const result = await service.dequeue();
      expect(result).toBeNull();
    });
  });

  describe('enqueue → dequeue → ack', () => {
    it('모든 작업 ack 시 그룹 완료를 반환한다', async () => {
      // given
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
      });
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-2',
        type: 'SEND',
        payload: {},
      });

      // when
      const first = await service.dequeue();
      expectNonNullable(first);
      const firstAck = await service.ack(first.id, first.groupId);

      const second = await service.dequeue();
      expectNonNullable(second);
      const secondAck = await service.ack(second.id, second.groupId);

      // then
      expect(firstAck).toBe(false);
      expect(secondAck).toBe(true);

      const result = (await redisService.hash.getAll(
        `${KEY_PREFIX}group:group-1:meta`,
      )) as unknown as JobGroupHash;
      expect(result.status).toBe('AGGREGATING');
      expect(result.doneJobs).toBe('2');
    });
  });

  async function enqueueJob(groupId: string, jobId: string): Promise<void> {
    await service.enqueue({ groupId, jobId, type: 'SEND', payload: {} });
  }
});
