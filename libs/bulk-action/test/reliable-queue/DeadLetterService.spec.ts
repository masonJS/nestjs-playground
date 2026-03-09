import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { DeadLetterService } from '@app/bulk-action/reliable-queue/DeadLetterService';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('DeadLetterService', () => {
  let module: TestingModule;
  let service: DeadLetterService;
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
        DeadLetterService,
      ],
    }).compile();

    await module.init();

    service = module.get(DeadLetterService);
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

  async function seedDLQEntry(
    jobId: string,
    groupId: string,
    failedAt?: number,
  ): Promise<void> {
    const entry = JSON.stringify({
      jobId,
      groupId,
      retryCount: 3,
      error: 'test error',
      failedAt: failedAt ?? Date.now(),
    });
    await redisService.list.append(keys.deadLetterQueue(), entry);

    // Job 데이터도 생성
    await redisService.hash.set(keys.job(jobId), 'id', jobId);
    await redisService.hash.set(keys.job(jobId), 'groupId', groupId);
    await redisService.hash.set(keys.job(jobId), 'retryCount', '3');
    await redisService.hash.set(keys.job(jobId), 'status', 'FAILED');
  }

  describe('size', () => {
    it('DLQ 크기를 반환한다', async () => {
      // given
      await seedDLQEntry('job-001', 'group-A');
      await seedDLQEntry('job-002', 'group-A');

      // when
      const size = await service.size();

      // then
      expect(size).toBe(2);
    });
  });

  describe('list', () => {
    it('페이지네이션으로 DLQ 항목을 조회한다', async () => {
      // given
      await seedDLQEntry('job-001', 'group-A');
      await seedDLQEntry('job-002', 'group-A');
      await seedDLQEntry('job-003', 'group-B');

      // when
      const page1 = await service.list(0, 2);
      const page2 = await service.list(2, 2);

      // then
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page1[0].jobId).toBe('job-001');
      expect(page2[0].jobId).toBe('job-003');
    });
  });

  describe('retry', () => {
    it('단건 작업을 Ready Queue에 재투입한다', async () => {
      // given
      await seedDLQEntry('job-001', 'group-A');

      // when
      const result = await service.retry('job-001');

      // then
      expect(result).toBe(true);

      // DLQ에서 제거됨
      expect(await service.size()).toBe(0);

      // Ready Queue에 추가됨
      const readyQueueSize = await redisService.list.length(keys.readyQueue());
      expect(readyQueueSize).toBe(1);

      // retryCount 리셋
      const retryCount = await redisService.hash.get(
        keys.job('job-001'),
        'retryCount',
      );
      expect(retryCount).toBe('0');

      // status 리셋
      const status = await redisService.hash.get(keys.job('job-001'), 'status');
      expect(status).toBe('PENDING');
    });

    it('존재하지 않는 jobId이면 false를 반환한다', async () => {
      // when
      const result = await service.retry('non-existent');

      // then
      expect(result).toBe(false);
    });
  });

  describe('retryAll', () => {
    it('전체 DLQ 항목을 Ready Queue에 재투입한다', async () => {
      // given
      await seedDLQEntry('job-001', 'group-A');
      await seedDLQEntry('job-002', 'group-B');

      // when
      const count = await service.retryAll();

      // then
      expect(count).toBe(2);
      expect(await service.size()).toBe(0);

      const readyQueueSize = await redisService.list.length(keys.readyQueue());
      expect(readyQueueSize).toBe(2);
    });
  });

  describe('purge', () => {
    it('단건 작업을 영구 삭제한다', async () => {
      // given
      await seedDLQEntry('job-001', 'group-A');
      await seedDLQEntry('job-002', 'group-A');

      // when
      const result = await service.purge('job-001');

      // then
      expect(result).toBe(true);
      expect(await service.size()).toBe(1);

      const remaining = await service.list(0, 10);
      expect(remaining[0].jobId).toBe('job-002');
    });
  });

  describe('cleanup', () => {
    it('보관 기간 초과 항목을 정리한다', async () => {
      // given
      const oldTime = Date.now() - 100000;
      await seedDLQEntry('job-old', 'group-A', oldTime);
      await seedDLQEntry('job-new', 'group-A', Date.now());

      // when
      const removed = await service.cleanup(50000);

      // then
      expect(removed).toBe(1);
      expect(await service.size()).toBe(1);

      const remaining = await service.list(0, 10);
      expect(remaining[0].jobId).toBe('job-new');
    });
  });
});
