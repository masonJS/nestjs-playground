import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { ReliableQueueService } from '@app/bulk-action/reliable-queue/ReliableQueueService';
import { InFlightQueueService } from '@app/bulk-action/reliable-queue/InFlightQueueService';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('InFlightQueueService', () => {
  let module: TestingModule;
  let service: InFlightQueueService;
  let reliableQueue: ReliableQueueService;
  let redisService: RedisService;
  let keys: RedisKeyBuilder;

  const config = createTestBulkActionConfig({
    reliableQueue: { ackTimeoutMs: 5000 },
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
        InFlightQueueService,
      ],
    }).compile();

    await module.init();

    service = module.get(InFlightQueueService);
    reliableQueue = module.get(ReliableQueueService);
    redisService = module.get(RedisService);
    keys = module.get(RedisKeyBuilder);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  async function seedAndDequeue(jobId: string, groupId: string): Promise<void> {
    await redisService.hash.set(keys.job(jobId), 'id', jobId);
    await redisService.hash.set(keys.job(jobId), 'groupId', groupId);
    await redisService.hash.set(keys.job(jobId), 'retryCount', '0');
    await redisService.hash.set(keys.job(jobId), 'processorType', 'TEST');
    await redisService.hash.set(keys.job(jobId), 'payload', '{}');
    await redisService.hash.set(keys.job(jobId), 'status', 'PENDING');
    await redisService.hash.set(keys.job(jobId), 'createdAt', '0');
    await redisService.list.append(keys.readyQueue(), jobId);
    await reliableQueue.dequeue('worker-0');
  }

  describe('size', () => {
    it('In-flight Queue 크기를 반환한다', async () => {
      // given
      await seedAndDequeue('job-001', 'group-A');
      await seedAndDequeue('job-002', 'group-A');

      // when
      const size = await service.size();

      // then
      expect(size).toBe(2);
    });
  });

  describe('isInFlight', () => {
    it('In-flight에 있는 작업이면 true를 반환한다', async () => {
      // given
      await seedAndDequeue('job-001', 'group-A');

      // when & then
      expect(await service.isInFlight('job-001')).toBe(true);
    });

    it('In-flight에 없는 작업이면 false를 반환한다', async () => {
      // when & then
      expect(await service.isInFlight('non-existent')).toBe(false);
    });
  });

  describe('getEntry', () => {
    it('메타데이터를 올바르게 파싱하여 반환한다', async () => {
      // given
      await seedAndDequeue('job-001', 'group-A');

      // when
      const entry = await service.getEntry('job-001');

      // then
      expect(entry).not.toBeNull();
      expect(entry!.jobId).toBe('job-001');
      expect(entry!.workerId).toBe('worker-0');
      expect(entry!.groupId).toBe('group-A');
      expect(entry!.retryCount).toBe(0);
      expect(entry!.deadline).toBeGreaterThan(Date.now());
    });

    it('존재하지 않는 작업이면 null을 반환한다', async () => {
      // when
      const entry = await service.getEntry('non-existent');

      // then
      expect(entry).toBeNull();
    });
  });

  describe('getAllEntries', () => {
    it('모든 In-flight 엔트리를 반환한다', async () => {
      // given
      await seedAndDequeue('job-001', 'group-A');
      await seedAndDequeue('job-002', 'group-B');

      // when
      const entries = await service.getAllEntries();

      // then
      expect(entries).toHaveLength(2);
      const jobIds = entries.map((e) => e.jobId).sort();
      expect(jobIds).toEqual(['job-001', 'job-002']);
    });
  });

  describe('orphanedCount', () => {
    it('만료된 작업이 없으면 0을 반환한다', async () => {
      // given
      await seedAndDequeue('job-001', 'group-A');

      // when
      const count = await service.orphanedCount();

      // then
      expect(count).toBe(0);
    });
  });
});
