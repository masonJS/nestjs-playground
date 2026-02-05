import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisConfig } from './RedisConfig';
import { LuaScriptDefinition } from './LuaScriptDefinition';

export const REDIS_CONFIG = Symbol('REDIS_CONFIG');

@Injectable()
export class RedisService implements OnModuleDestroy {
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

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zrange(key, start, stop);
  }

  async flushdb(): Promise<string> {
    return this.client.flushdb();
  }
}
