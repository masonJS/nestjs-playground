import Redis from 'ioredis';

export class RedisList {
  constructor(private readonly client: Redis) {}

  async length(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async range(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async append(key: string, value: string): Promise<number> {
    return this.client.rpush(key, value);
  }

  async popHead(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async blockingPopHead(
    key: string,
    timeoutSec: number,
  ): Promise<string | null> {
    const result = await this.client.blpop(key, timeoutSec);

    return result ? result[1] : null;
  }
}
