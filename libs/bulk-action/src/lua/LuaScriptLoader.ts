import * as fs from 'fs/promises';
import * as path from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';

@Injectable()
export class LuaScriptLoader implements OnModuleInit {
  constructor(private readonly redisService: RedisService) {}

  async onModuleInit(): Promise<void> {
    await this.loadScript('enqueue', 'enqueue.lua', 4);
    await this.loadScript('dequeue', 'dequeue.lua', 3);
    await this.loadScript('ack', 'ack.lua', 2);
  }

  private async loadScript(
    name: string,
    filename: string,
    numberOfKeys: number,
  ): Promise<void> {
    const luaPath = path.join(__dirname, filename);
    const lua = await fs.readFile(luaPath, 'utf-8');

    this.redisService.defineCommand({ name, numberOfKeys, lua });
  }
}
