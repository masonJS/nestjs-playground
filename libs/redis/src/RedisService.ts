import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisConfig } from './RedisConfig';
import { LuaScriptDefinition } from './LuaScriptDefinition';
import { RedisHash } from './operations/RedisHash';
import { RedisList } from './operations/RedisList';
import { RedisSet } from './operations/RedisSet';
import { RedisSortedSet } from './operations/RedisSortedSet';
import { RedisString } from './operations/RedisString';

export const REDIS_CONFIG = Symbol('REDIS_CONFIG');

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly string: RedisString;
  readonly list: RedisList;
  readonly hash: RedisHash;
  readonly set: RedisSet;
  readonly sortedSet: RedisSortedSet;

  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(@Inject(REDIS_CONFIG) config: RedisConfig) {
    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });

    this.string = new RedisString(this.client);
    this.list = new RedisList(this.client);
    this.hash = new RedisHash(this.client);
    this.set = new RedisSet(this.client);
    this.sortedSet = new RedisSortedSet(this.client);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  defineCommand(definition: LuaScriptDefinition): void {
    this.client.defineCommand(definition.name, {
      numberOfKeys: definition.numberOfKeys,
      lua: definition.lua,
    });
  }

  async callCommand(
    name: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    const command = (this.client as unknown as Record<string, unknown>)[name];

    if (typeof command !== 'function') {
      throw new Error(
        `Lua command '${name}' is not defined. Call defineCommand() first.`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/ban-types
    return (command as Function).call(this.client, ...keys, ...args);
  }

  async flushDatabase(): Promise<string> {
    return this.client.flushdb();
  }
}
