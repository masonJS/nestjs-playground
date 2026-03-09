import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { ReliableQueueService } from '@app/bulk-action/reliable-queue/ReliableQueueService';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('ReliableQueueService', () => {
  let module: TestingModule;
  let service: ReliableQueueService;
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
      ],
    }).compile();

    await module.init();

    service = module.get(ReliableQueueService);
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

  async function seedJob(jobId: string, groupId: string): Promise<void> {
    await redisService.hash.set(keys.job(jobId), 'id', jobId);
    await redisService.hash.set(keys.job(jobId), 'groupId', groupId);
    await redisService.hash.set(keys.job(jobId), 'retryCount', '0');
    await redisService.hash.set(keys.job(jobId), 'processorType', 'TEST');
    await redisService.hash.set(keys.job(jobId), 'payload', '{}');
    await redisService.hash.set(keys.job(jobId), 'status', 'PENDING');
    await redisService.hash.set(keys.job(jobId), 'createdAt', '0');
    await redisService.list.append(keys.readyQueue(), jobId);
  }

  describe('dequeue', () => {
    it('Ready Queue에서 작업을 꺼내 In-flight Queue로 이동한다', async () => {
      // given
      await seedJob('job-001', 'group-A');

      // when
      const result = await service.dequeue('worker-0');

      // then
      expect(result).not.toBeNull();
      expect(result!.jobId).toBe('job-001');
      expect(result!.deadline).toBeGreaterThan(Date.now());

      // Ready Queue는 비어야 함
      const readyQueueSize = await redisService.list.length(keys.readyQueue());
      expect(readyQueueSize).toBe(0);

      // In-flight Queue에 존재해야 함
      const inFlightScore = await redisService.sortedSet.score(
        keys.inFlightQueue(),
        'job-001',
      );
      expect(inFlightScore).not.toBeNull();
    });

    it('빈 Ready Queue에서는 null을 반환한다', async () => {
      // when
      const result = await service.dequeue('worker-0');

      // then
      expect(result).toBeNull();
    });

    it('메타데이터를 올바르게 저장한다', async () => {
      // given
      await seedJob('job-001', 'group-A');

      // when
      await service.dequeue('worker-0');

      // then
      const meta = await redisService.hash.getAll(keys.inFlightMeta('job-001'));
      expect(meta.jobId).toBe('job-001');
      expect(meta.workerId).toBe('worker-0');
      expect(meta.instanceId).toBe(service.getInstanceId());
      expect(meta.groupId).toBe('group-A');
      expect(meta.retryCount).toBe('0');
    });
  });

  describe('ack', () => {
    it('In-flight Queue에서 작업을 제거한다', async () => {
      // given
      await seedJob('job-001', 'group-A');
      await service.dequeue('worker-0');

      // when
      const result = await service.ack('job-001');

      // then
      expect(result).toBe(true);

      const inFlightSize = await redisService.sortedSet.count(
        keys.inFlightQueue(),
      );
      expect(inFlightSize).toBe(0);

      // 메타데이터도 삭제되어야 함
      const meta = await redisService.hash.getAll(keys.inFlightMeta('job-001'));
      expect(Object.keys(meta).length).toBe(0);
    });

    it('이미 복구된 작업 ack은 false를 반환한다', async () => {
      // given — In-flight에 없는 job
      // when
      const result = await service.ack('non-existent-job');

      // then
      expect(result).toBe(false);
    });
  });

  describe('nack', () => {
    it('In-flight Queue에서 작업을 제거한다', async () => {
      // given
      await seedJob('job-001', 'group-A');
      await service.dequeue('worker-0');

      // when
      await service.nack('job-001');

      // then
      const inFlightSize = await redisService.sortedSet.count(
        keys.inFlightQueue(),
      );
      expect(inFlightSize).toBe(0);
    });
  });

  describe('extendDeadline', () => {
    it('deadline을 연장한다', async () => {
      // given
      await seedJob('job-001', 'group-A');
      const dequeueResult = await service.dequeue('worker-0');
      const originalDeadline = dequeueResult!.deadline;

      // when
      const result = await service.extendDeadline('job-001', 10000);

      // then
      expect(result).toBe(true);

      const newScore = await redisService.sortedSet.score(
        keys.inFlightQueue(),
        'job-001',
      );
      expect(newScore).toBeGreaterThan(originalDeadline);
    });

    it('존재하지 않는 작업이면 false를 반환한다', async () => {
      // when
      const result = await service.extendDeadline('non-existent-job');

      // then
      expect(result).toBe(false);
    });
  });

  describe('getInstanceId', () => {
    it('UUID 형식의 인스턴스 ID를 반환한다', () => {
      // when
      const id = service.getInstanceId();

      // then
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
});
