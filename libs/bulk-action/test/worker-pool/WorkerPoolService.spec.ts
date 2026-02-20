import { setTimeout } from 'timers/promises';
import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisService } from '@app/redis/RedisService';
import { WorkerPoolService } from '@app/bulk-action/worker-pool/WorkerPoolService';
import { JobProcessor } from '@app/bulk-action/model/job-processor/JobProcessor';
import { Job } from '@app/bulk-action/model/job/Job';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';
import { BulkActionModule } from '@app/bulk-action/BulkActionModule';
import { WorkerState } from '@app/bulk-action/model/WorkerState';

@Injectable()
class SlowTestProcessor implements JobProcessor {
  readonly type = 'SLOW_TEST';

  async process(job: Job): Promise<JobProcessorResponse> {
    await setTimeout(2000);

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      durationMs: 2000,
    };
  }
}

describe('WorkerPoolService (Integration)', () => {
  let module: TestingModule;
  let pool: WorkerPoolService;
  let redisService: RedisService;

  const env = Configuration.getEnv();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: {
            host: env.redis.host,
            port: env.redis.port,
            password: env.redis.password,
            db: env.redis.db,
            keyPrefix: 'test-pool:',
          },
          workerPool: {
            workerCount: 3,
            workerTimeoutSec: 1,
            shutdownGracePeriodMs: 5000,
            fetchIntervalMs: 50,
          },
        }),
        BulkActionModule.registerProcessors([SlowTestProcessor]),
      ],
    }).compile();

    pool = module.get(WorkerPoolService);
    redisService = module.get(RedisService);

    await module.init();
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await redisService.flushDatabase();
  });

  it('Worker Pool이 초기화되면 Worker가 생성된다', () => {
    // when
    const status = pool.getPoolStatus();

    // then
    expect(status.workerCount).toBe(3);
    expect(status.isShuttingDown).toBe(false);
  });

  it('getPoolStatus()가 올바른 상태를 반환한다', () => {
    // when
    const status = pool.getPoolStatus();

    // then
    expect(status.workerCount).toBe(3);
    expect(status.workers).toHaveLength(3);
    expect(status.fetcherRunning).toBeDefined();
    expect(status.dispatcherRunning).toBeDefined();
    expect(status.fetcherStats).toBeDefined();
    expect(status.dispatcherStats).toBeDefined();
  });

  it('shutdown 시 isShuttingDown이 true가 된다', async () => {
    // when
    await pool.onApplicationShutdown('SIGTERM');

    // then
    const status = pool.getPoolStatus();
    expect(status.isShuttingDown).toBe(true);

    const stoppedWorkers = status.workers.filter(
      (w) => w.state === WorkerState.STOPPED,
    );
    expect(stoppedWorkers.length).toBe(3);
  });
});
