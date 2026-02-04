import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { Configuration } from '@app/config/Configuration';
import { FairQueueService } from '@app/bulk-action/fair-queue/FairQueueService';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import {
  REDIS_CLIENT,
  BULK_ACTION_CONFIG,
} from '@app/bulk-action/redis/RedisProvider';
import { BulkActionConfig } from '@app/bulk-action/config/BulkActionConfig';
import { JobStatus } from '@app/bulk-action/model/Job';
import { PriorityLevel } from '@app/bulk-action/model/JobGroup';
import { expectNonNullable } from '../../../web-common/test/unit/expectNonNullable';

describe('FairQueueService', () => {
  let module: TestingModule;
  let service: FairQueueService;
  let redis: Redis;

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
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        {
          provide: REDIS_CLIENT,
          useFactory: () =>
            new Redis({
              host: config.redis.host,
              port: config.redis.port,
              password: config.redis.password,
              db: config.redis.db,
            }),
        },
        {
          provide: BULK_ACTION_CONFIG,
          useValue: config,
        },
        LuaScriptLoader,
        FairQueueService,
      ],
    }).compile();

    await module.init();

    service = module.get(FairQueueService);
    redis = module.get(REDIS_CLIENT);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
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
      const jobData = await redis.hgetall(`${KEY_PREFIX}job:${jobId}`);
      expect(jobData.id).toBe(jobId);
      expect(jobData.groupId).toBe(groupId);
      expect(jobData.type).toBe('SEND_PROMOTION');
      expect(JSON.parse(jobData.payload)).toEqual(payload);
      expect(jobData.status).toBe(JobStatus.PENDING);
      expect(Number(jobData.createdAt)).toBeGreaterThan(0);
    });

    it('그룹 작업 목록에 jobId가 추가된다', async () => {
      // given & when
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
      const jobs = await redis.lrange(`${KEY_PREFIX}group:group-1:jobs`, 0, -1);
      expect(jobs).toEqual(['job-1', 'job-2']);
    });

    it('그룹 메타데이터가 생성된다', async () => {
      // given & when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
        basePriority: 100,
        priorityLevel: PriorityLevel.HIGH,
      });

      // then
      const meta = await redis.hgetall(`${KEY_PREFIX}group:group-1:meta`);
      expect(meta.totalJobs).toBe('1');
      expect(meta.doneJobs).toBe('0');
      expect(meta.basePriority).toBe('100');
      expect(meta.priorityLevel).toBe('high');
      expect(meta.status).toBe('CREATED');
    });

    it('같은 그룹에 작업 추가 시 totalJobs가 증가한다', async () => {
      // given & when
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
      const totalJobs = await redis.hget(
        `${KEY_PREFIX}group:group-1:meta`,
        'totalJobs',
      );
      expect(totalJobs).toBe('2');
    });

    it('그룹이 해당 priority 큐의 sorted set에 등록된다', async () => {
      // given & when
      await service.enqueue({
        groupId: 'group-1',
        jobId: 'job-1',
        type: 'SEND',
        payload: {},
        priorityLevel: PriorityLevel.HIGH,
      });

      // then
      const members = await redis.zrange(
        `${KEY_PREFIX}fair-queue:high`,
        0,
        -1,
      );
      expect(members).toEqual(['group-1']);
    });

    it('서로 다른 priority 큐에 그룹이 분리된다', async () => {
      // given & when
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
      const stats = await service.getQueueStats();
      expect(stats.highPriorityGroups).toBe(1);
      expect(stats.normalPriorityGroups).toBe(0);
      expect(stats.lowPriorityGroups).toBe(1);
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
      const job = await service.dequeue();

      // then
      expectNonNullable(job);
      expect(job.id).toBe('job-1');
      expect(job.groupId).toBe('group-1');
      expect(job.type).toBe('SEND');
      expect(JSON.parse(job.payload)).toEqual(payload);
      expect(job.status).toBe(JobStatus.PROCESSING);
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
      const job = await service.dequeue();
      expect(job).toBeNull();
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

      const meta = await redis.hgetall(`${KEY_PREFIX}group:group-1:meta`);
      expect(meta.status).toBe('AGGREGATING');
      expect(meta.doneJobs).toBe('2');
    });
  });
});
