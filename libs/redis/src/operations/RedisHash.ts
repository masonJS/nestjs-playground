import Redis from 'ioredis';

export class RedisHash {
  constructor(private readonly client: Redis) {}

  async getAll(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async get(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async set(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(key, field, value);
  }
}
