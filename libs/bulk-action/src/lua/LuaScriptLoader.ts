import * as fs from 'fs';
import * as path from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '@app/redis/RedisService';

@Injectable()
export class LuaScriptLoader implements OnModuleInit {
  constructor(private readonly redisService: RedisService) {}

  onModuleInit(): void {
    this.loadScript('enqueue', 'enqueue.lua', 4);
    this.loadScript('dequeue', 'dequeue.lua', 3);
    this.loadScript('ack', 'ack.lua', 2);
    this.loadScript('rateLimitCheck', 'rate-limit-check.lua', 3);
    this.loadScript('readyQueuePush', 'ready-queue-push.lua', 1);
    this.loadScript('moveToReady', 'move-to-ready.lua', 2);
    this.loadScript('congestionBackoff', 'congestion-backoff.lua', 4);
    this.loadScript('congestionRelease', 'congestion-release.lua', 2);
    this.loadScript('recordJobResult', 'record-job-result.lua', 2);
    this.loadScript('transitionStatus', 'transition-status.lua', 1);
    this.loadScript('acquireLock', 'acquire-lock.lua', 1);
    this.loadScript('releaseLock', 'release-lock.lua', 1);
    this.loadScript('reliableDequeue', 'reliable-dequeue.lua', 3);
    this.loadScript('reliableAck', 'reliable-ack.lua', 2);
    this.loadScript('recoverOrphans', 'recover-orphans.lua', 4);
    this.loadScript('extendDeadline', 'extend-deadline.lua', 2);
  }

  private loadScript(
    name: string,
    filename: string,
    numberOfKeys: number,
  ): void {
    const luaPath = path.join(
      process.cwd(),
      'libs/bulk-action/src/lua',
      filename,
    );
    const lua = fs.readFileSync(luaPath, 'utf-8');

    this.redisService.defineCommand({ name, numberOfKeys, lua });
  }
}
