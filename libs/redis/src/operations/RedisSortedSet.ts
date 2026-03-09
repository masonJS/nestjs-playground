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

  async score(key: string, member: string): Promise<number | null> {
    const result = await this.client.zscore(key, member);

    return result !== null ? parseFloat(result) : null;
  }

  async rangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const raw = await this.client.zrange(key, start, stop, 'WITHSCORES');
    const result: Array<{ member: string; score: number }> = [];

    for (let i = 0; i < raw.length; i += 2) {
      result.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
    }

    return result;
  }

  async countByScore(key: string, min: string, max: string): Promise<number> {
    return this.client.zcount(key, min, max);
  }
}
