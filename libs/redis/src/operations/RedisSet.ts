import Redis from 'ioredis';

export class RedisSet {
  constructor(private readonly client: Redis) {}

  async add(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  async remove(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  async size(key: string): Promise<number> {
    return this.client.scard(key);
  }

  async members(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }
}
