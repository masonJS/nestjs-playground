import Redis from 'ioredis';

export class RedisSortedSet {
  constructor(private readonly client: Redis) {}

  async count(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async range(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zrange(key, start, stop);
  }

  async add(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score.toString(), member);
  }

  async rangeByScore(
    key: string,
    min: string,
    max: string,
    offset?: number,
    count?: number,
  ): Promise<string[]> {
    if (offset !== undefined && count !== undefined) {
      return this.client.zrangebyscore(key, min, max, 'LIMIT', offset, count);
    }

    return this.client.zrangebyscore(key, min, max);
  }

  async remove(key: string, ...members: string[]): Promise<number> {
    return this.client.zrem(key, ...members);
  }
}
