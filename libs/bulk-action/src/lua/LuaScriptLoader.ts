import * as fs from 'fs/promises';
import * as path from 'path';
import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/RedisProvider';

@Injectable()
export class LuaScriptLoader implements OnModuleInit {
  private readonly scripts: Map<string, string> = new Map();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    await this.loadScript('enqueue', 'enqueue.lua');
    await this.loadScript('dequeue', 'dequeue.lua');
    await this.loadScript('ack', 'ack.lua');
  }

  private async loadScript(name: string, filename: string): Promise<void> {
    const luaPath = path.join(__dirname, filename);
    const script = await fs.readFile(luaPath, 'utf-8');

    this.redis.defineCommand(name, {
      numberOfKeys: this.getKeyCount(name),
      lua: script,
    });
    this.scripts.set(name, script);
  }

  private getKeyCount(name: string): number {
    const keyCounts: Record<string, number> = {
      enqueue: 4,
      dequeue: 3,
      ack: 2,
    };

    return keyCounts[name] ?? 0;
  }
}
