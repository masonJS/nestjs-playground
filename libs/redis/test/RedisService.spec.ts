import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisModule } from '@app/redis/RedisModule';
import { RedisService } from '@app/redis/RedisService';

describe('RedisService', () => {
  let module: TestingModule;
  let service: RedisService;

  const env = Configuration.getEnv();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          host: env.redis.host,
          port: env.redis.port,
          password: env.redis.password,
          db: env.redis.db,
        }),
      ],
    }).compile();

    await module.init();

    service = module.get(RedisService);
  });

  beforeEach(async () => {
    await service.flushDatabase();
  });

  afterAll(async () => {
    await service.flushDatabase();
    await module.close();
  });

  describe('Hash', () => {
    it('저장된 Hash의 모든 필드를 조회한다', async () => {
      // given
      await service.callCommand(
        'hset',
        ['test:hash'],
        ['name', 'minwoo', 'age', '30'],
      );

      // when
      const result = await service.getHashAll('test:hash');

      // then
      expect(result.name).toBe('minwoo');
      expect(result.age).toBe('30');
    });

    it('저장된 Hash의 특정 필드를 조회한다', async () => {
      // given
      await service.callCommand(
        'hset',
        ['test:hash'],
        ['name', 'minwoo', 'age', '30'],
      );

      // when
      const result = await service.getHash('test:hash', 'name');

      // then
      expect(result).toBe('minwoo');
    });

    it('존재하지 않는 Hash 필드 조회 시 null을 반환한다', async () => {
      // when
      const result = await service.getHash('nonexistent', 'field');

      // then
      expect(result).toBeNull();
    });
  });

  describe('List', () => {
    it('List의 길이를 반환한다', async () => {
      // given
      await service.callCommand('rpush', ['test:list'], ['a', 'b', 'c']);

      // when
      const result = await service.getListLength('test:list');

      // then
      expect(result).toBe(3);
    });

    it('List의 범위를 조회한다', async () => {
      // given
      await service.callCommand('rpush', ['test:list'], ['a', 'b', 'c']);

      // when
      const result = await service.getListRange('test:list', 0, -1);

      // then
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('존재하지 않는 List의 길이는 0이다', async () => {
      // when
      const result = await service.getListLength('nonexistent');

      // then
      expect(result).toBe(0);
    });
  });

  describe('Sorted Set', () => {
    it('Sorted Set의 멤버 수를 반환한다', async () => {
      // given
      await service.callCommand('zadd', ['test:zset'], ['10', 'a', '20', 'b']);

      // when
      const result = await service.getSortedSetCount('test:zset');

      // then
      expect(result).toBe(2);
    });

    it('Sorted Set의 범위를 score 오름차순으로 조회한다', async () => {
      // given
      await service.callCommand(
        'zadd',
        ['test:zset'],
        ['20', 'b', '10', 'a', '30', 'c'],
      );

      // when
      const result = await service.getSortedSetRange('test:zset', 0, -1);

      // then
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('존재하지 않는 Sorted Set의 멤버 수는 0이다', async () => {
      // when
      const result = await service.getSortedSetCount('nonexistent');

      // then
      expect(result).toBe(0);
    });
  });

  describe('Lua Command', () => {
    it('등록한 Lua 스크립트를 실행할 수 있다', async () => {
      // given
      service.defineCommand({
        name: 'testcommand',
        numberOfKeys: 1,
        lua: `
          redis.call('SET', KEYS[1], ARGV[1])
          return redis.call('GET', KEYS[1])
        `,
      });

      // when
      const result = await service.callCommand(
        'testcommand',
        ['test:lua'],
        ['hello'],
      );

      // then
      expect(result).toBe('hello');
    });

    it('등록되지 않은 명령 호출 시 에러가 발생한다', async () => {
      // when & then
      await expect(
        service.callCommand('unknown_command', [], []),
      ).rejects.toThrow("Lua command 'unknown_command' is not defined");
    });
  });

  describe('flushDatabase', () => {
    it('데이터베이스의 모든 키를 삭제한다', async () => {
      // given
      await service.callCommand('set', ['test:key1'], ['value1']);
      await service.callCommand('set', ['test:key2'], ['value2']);

      // when
      await service.flushDatabase();

      // then
      const result = await service.getHash('test:key1', 'field');
      expect(result).toBeNull();
    });
  });
});
