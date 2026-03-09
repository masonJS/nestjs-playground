import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { BULK_ACTION_CONFIG } from '@app/bulk-action/config/BulkActionConfig';
import { IdempotencyService } from '@app/bulk-action/idempotency/IdempotencyService';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('IdempotencyService', () => {
  let module: TestingModule;
  let service: IdempotencyService;
  let redisService: RedisService;

  const config = createTestBulkActionConfig({
    reliableQueue: { idempotencyTtlMs: 5000 },
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
        IdempotencyService,
      ],
    }).compile();

    await module.init();

    service = module.get(IdempotencyService);
    redisService = module.get(RedisService);
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    await redisService.flushDatabase();
    await module.close();
  });

  describe('isProcessed', () => {
    it('첫 번째 호출 시 false를 반환한다 (미처리)', async () => {
      // when
      const result = await service.isProcessed('key-001');

      // then
      expect(result).toBe(false);
    });

    it('두 번째 호출 시 true를 반환한다 (이미 처리됨)', async () => {
      // given
      await service.isProcessed('key-001');

      // when
      const result = await service.isProcessed('key-001');

      // then
      expect(result).toBe(true);
    });

    it('다른 키는 독립적이다', async () => {
      // given
      await service.isProcessed('key-001');

      // when
      const result = await service.isProcessed('key-002');

      // then
      expect(result).toBe(false);
    });
  });

  describe('reset', () => {
    it('마킹을 제거한다', async () => {
      // given
      await service.isProcessed('key-001');

      // when
      await service.reset('key-001');

      // then
      const result = await service.isProcessed('key-001');
      expect(result).toBe(false);
    });
  });

  describe('filterUnprocessed', () => {
    it('미처리 키 목록만 반환한다', async () => {
      // given
      await service.isProcessed('key-001');
      await service.isProcessed('key-003');

      // when
      const result = await service.filterUnprocessed([
        'key-001',
        'key-002',
        'key-003',
        'key-004',
      ]);

      // then
      expect(result).toEqual(['key-002', 'key-004']);
    });

    it('모두 미처리이면 전체를 반환한다', async () => {
      // when
      const result = await service.filterUnprocessed(['key-a', 'key-b']);

      // then
      expect(result).toEqual(['key-a', 'key-b']);
    });
  });
});
