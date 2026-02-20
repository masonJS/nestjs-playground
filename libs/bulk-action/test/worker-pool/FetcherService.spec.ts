import { setTimeout } from 'timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { RedisService } from '@app/redis/RedisService';
import { FairQueueService } from '@app/bulk-action/fair-queue/FairQueueService';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { FetcherService } from '@app/bulk-action/worker-pool/FetcherService';
import { BulkActionModule } from '@app/bulk-action/BulkActionModule';
import { WorkerPoolService } from '@app/bulk-action/worker-pool/WorkerPoolService';

describe('FetcherService (Integration)', () => {
  let module: TestingModule;
  let fetcher: FetcherService;
  let fairQueue: FairQueueService;
  let readyQueue: ReadyQueueService;
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
            keyPrefix: 'test-fetcher:',
          },
          backpressure: { globalRps: 100, readyQueueMaxSize: 10 },
          workerPool: {
            fetchIntervalMs: 50,
            fetchBatchSize: 5,
            workerCount: 0,
            workerTimeoutSec: 1,
          },
        }),
      ],
    }).compile();

    fetcher = module.get(FetcherService);
    fairQueue = module.get(FairQueueService);
    readyQueue = module.get(ReadyQueueService);
    redisService = module.get(RedisService);

    await module.init();
  });

  beforeEach(async () => {
    fetcher.stop();
    await redisService.flushDatabase();
  });

  afterAll(async () => {
    fetcher.stop();
    await module.get(WorkerPoolService).onApplicationShutdown('test-cleanup');
    await module.close();
  });

  it('Fair Queue에서 작업을 꺼내 Ready Queue로 전달한다', async () => {
    // given
    for (let i = 0; i < 5; i++) {
      await fairQueue.enqueue({
        jobGroupId: 'customer-A',
        jobId: `job-${i}`,
        jobProcessorType: 'TEST',
        payload: {},
      });
    }

    // when
    fetcher.start();
    await setTimeout(300);

    // then
    const readySize = await readyQueue.size();
    expect(readySize).toBeGreaterThan(0);
    expect(readySize).toBeLessThanOrEqual(5);
  });

  it('Ready Queue가 가득 차면 fetch를 중단한다', async () => {
    // given — 20개 작업 등록 (readyQueueMaxSize=10)
    for (let i = 0; i < 20; i++) {
      await fairQueue.enqueue({
        jobGroupId: 'customer-A',
        jobId: `job-${i}`,
        jobProcessorType: 'TEST',
        payload: {},
      });
    }

    // when
    fetcher.start();
    await setTimeout(500);

    // then
    const readySize = await readyQueue.size();
    expect(readySize).toBeLessThanOrEqual(10);

    const stats = fetcher.getStats();
    expect(stats.totalFetched).toBeGreaterThan(0);
  });

  it('start/stop이 올바르게 동작한다', () => {
    // given
    expect(fetcher.isRunning()).toBe(false);

    // when - start
    fetcher.start();
    expect(fetcher.isRunning()).toBe(true);

    // when - stop
    fetcher.stop();
    expect(fetcher.isRunning()).toBe(false);
  });

  it('Fair Queue가 비어있으면 emptyPolls 통계가 증가한다', async () => {
    // given — Fair Queue에 작업 없음
    const statsBefore = fetcher.getStats();

    // when
    fetcher.start();
    await setTimeout(200);

    // then
    const statsAfter = fetcher.getStats();
    expect(
      statsAfter.totalEmptyPolls - statsBefore.totalEmptyPolls,
    ).toBeGreaterThan(0);
    expect(statsAfter.totalFetched - statsBefore.totalFetched).toBe(0);
  });
});
