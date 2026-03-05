import { Test, TestingModule } from '@nestjs/testing';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';
import { RedisKeyBuilder } from '@app/bulk-action/key/RedisKeyBuilder';
import { LuaScriptLoader } from '@app/bulk-action/lua/LuaScriptLoader';
import { DistributedLockService } from '@app/bulk-action/lock/DistributedLockService';
import {
  BULK_ACTION_CONFIG,
  BulkActionConfig,
} from '@app/bulk-action/config/BulkActionConfig';
import { createTestBulkActionConfig } from '../TestBulkActionConfig';

describe('DistributedLockService', () => {
  let module: TestingModule;
  let service: DistributedLockService;
  let redisService: RedisService;

  const config = createTestBulkActionConfig({
    watcher: {
      lockTtlMs: 2000,
      lockRetryCount: 2,
      lockRetryDelayMs: 100,
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
      ],
    }).compile();

    await module.init();

    service = module.get(DistributedLockService);
    redisService = module.get(RedisService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  const LOCK_KEY = 'test:lock:my-resource';

  describe('acquire / release', () => {
    it('락을 획득하고 해제한다', async () => {
      // given / when
      const token = await service.acquire(LOCK_KEY);

      // then
      expect(token).not.toBeNull();

      // when
      const released = await service.release(LOCK_KEY, token!);

      // then
      expect(released).toBe(true);
    });

    it('이중 획득을 방지한다', async () => {
      // given
      const token1 = await service.acquire(LOCK_KEY);
      expect(token1).not.toBeNull();

      // when
      const token2 = await service.acquire(LOCK_KEY);

      // then
      expect(token2).toBeNull();

      // cleanup
      await service.release(LOCK_KEY, token1!);
    });

    it('다른 소유자가 해제할 수 없다', async () => {
      // given
      const token = await service.acquire(LOCK_KEY);
      expect(token).not.toBeNull();

      // when
      const released = await service.release(LOCK_KEY, 'wrong-token');

      // then
      expect(released).toBe(false);

      // cleanup
      await service.release(LOCK_KEY, token!);
    });

    it('TTL 만료 후 재획득할 수 있다', async () => {
      // given — config의 lockTtlMs = 2000
      const shortTtlConfig: BulkActionConfig = {
        ...config,
        watcher: {
          ...config.watcher,
          lockTtlMs: 200,
          lockRetryCount: 0,
        },
      };

      const shortModule = await Test.createTestingModule({
        imports: [
          RedisModule.register({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
          }),
        ],
        providers: [
          { provide: BULK_ACTION_CONFIG, useValue: shortTtlConfig },
          RedisKeyBuilder,
          LuaScriptLoader,
          DistributedLockService,
        ],
      }).compile();

      await shortModule.init();
      const shortService = shortModule.get(DistributedLockService);

      const token1 = await shortService.acquire(LOCK_KEY);
      expect(token1).not.toBeNull();

      // when — wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 300));

      const token2 = await shortService.acquire(LOCK_KEY);

      // then
      expect(token2).not.toBeNull();

      await shortModule.close();
    });
  });

  describe('withLock', () => {
    it('콜백을 실행하고 결과를 반환한다', async () => {
      // given / when
      const result = await service.withLock(LOCK_KEY, async () => 42);

      // then
      expect(result).toBe(42);
    });

    it('콜백 에러 시에도 락을 해제한다', async () => {
      // given / when
      await expect(
        service.withLock(LOCK_KEY, async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');

      // then — lock should be released, so we can acquire it again
      const token = await service.acquire(LOCK_KEY);
      expect(token).not.toBeNull();
      await service.release(LOCK_KEY, token!);
    });

    it('락 획득 실패 시 null을 반환한다', async () => {
      // given — 먼저 락 점유
      const token = await service.acquire(LOCK_KEY);
      expect(token).not.toBeNull();

      // when
      const result = await service.withLock(
        LOCK_KEY,
        async () => 'should not reach',
      );

      // then
      expect(result).toBeNull();

      // cleanup
      await service.release(LOCK_KEY, token!);
    });
  });
});
