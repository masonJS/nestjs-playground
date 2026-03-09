import { DynamicModule, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis/RedisModule';
import { AggregatorService } from './aggregator/AggregatorService';
import { AGGREGATOR } from './aggregator/AggregatorInterface';
import { DefaultAggregator } from './aggregator/DefaultAggregator';
import { BackpressureService } from './backpressure/BackpressureService';
import { DispatcherService } from './backpressure/DispatcherService';
import { NonReadyQueueService } from './backpressure/NonReadyQueueService';
import { RateLimiterService } from './backpressure/RateLimiterService';
import { ReadyQueueService } from './backpressure/ReadyQueueService';
import {
  AggregatorConfig,
  BackpressureConfig,
  BULK_ACTION_CONFIG,
  BulkActionConfig,
  BulkActionRedisConfig,
  CongestionConfig,
  DEFAULT_AGGREGATOR_CONFIG,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_RELIABLE_QUEUE_CONFIG,
  DEFAULT_WATCHER_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
  FairQueueConfig,
  ReliableQueueConfig,
  WatcherConfig,
  WorkerPoolConfig,
} from './config/BulkActionConfig';
import { CongestionControlService } from './congestion/CongestionControlService';
import { CongestionStatsService } from './congestion/CongestionStatsService';
import { FairQueueService } from './fair-queue/FairQueueService';
import { RedisKeyBuilder } from './key/RedisKeyBuilder';
import { DistributedLockService } from './lock/DistributedLockService';
import { LuaScriptLoader } from './lua/LuaScriptLoader';
import { BulkActionService } from './BulkActionService';
import { EmailProcessor } from './processor/EmailProcessor';
import { PushNotificationProcessor } from './processor/PushNotificationProcessor';
import { FetcherService } from './worker-pool/FetcherService';
import { JOB_PROCESSOR } from './model/job-processor/JobProcessor';
import { WorkerPoolService } from './worker-pool/WorkerPoolService';
import { ReliableQueueService } from './reliable-queue/ReliableQueueService';
import { InFlightQueueService } from './reliable-queue/InFlightQueueService';
import { OrphanRecoveryService } from './reliable-queue/OrphanRecoveryService';
import { DeadLetterService } from './reliable-queue/DeadLetterService';
import { IdempotencyService } from './idempotency/IdempotencyService';
import { WatcherService } from './watcher/WatcherService';

@Module({})
export class BulkActionModule {
  static register(
    config: { redis: BulkActionRedisConfig } & {
      fairQueue?: Partial<FairQueueConfig>;
      backpressure?: Partial<BackpressureConfig>;
      congestion?: Partial<CongestionConfig>;
      workerPool?: Partial<WorkerPoolConfig>;
      aggregator?: Partial<AggregatorConfig>;
      watcher?: Partial<WatcherConfig>;
      reliableQueue?: Partial<ReliableQueueConfig>;
    },
  ): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      redis: config.redis,
      fairQueue: {
        ...DEFAULT_FAIR_QUEUE_CONFIG,
        ...config.fairQueue,
      },
      backpressure: {
        ...DEFAULT_BACKPRESSURE_CONFIG,
        ...config.backpressure,
      },
      congestion: {
        ...DEFAULT_CONGESTION_CONFIG,
        ...config.congestion,
      },
      workerPool: {
        ...DEFAULT_WORKER_POOL_CONFIG,
        ...config.workerPool,
      },
      aggregator: {
        ...DEFAULT_AGGREGATOR_CONFIG,
        ...config.aggregator,
      },
      watcher: {
        ...DEFAULT_WATCHER_CONFIG,
        ...config.watcher,
      },
      reliableQueue: {
        ...DEFAULT_RELIABLE_QUEUE_CONFIG,
        ...config.reliableQueue,
      },
    };

    return {
      module: BulkActionModule,
      imports: [
        RedisModule.register({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
        }),
      ],
      providers: [
        {
          provide: BULK_ACTION_CONFIG,
          useValue: mergedConfig,
        },
        RedisKeyBuilder,
        LuaScriptLoader,
        FairQueueService,
        RateLimiterService,
        ReadyQueueService,
        NonReadyQueueService,
        DispatcherService,
        BackpressureService,
        CongestionControlService,
        CongestionStatsService,
        FetcherService,
        DistributedLockService,
        AggregatorService,
        WatcherService,
        ReliableQueueService,
        InFlightQueueService,
        OrphanRecoveryService,
        DeadLetterService,
        IdempotencyService,
        WorkerPoolService,
        BulkActionService,
        EmailProcessor,
        PushNotificationProcessor,
        DefaultAggregator,
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator) => [defaultAgg],
          inject: [DefaultAggregator],
        },
        {
          provide: JOB_PROCESSOR,
          useFactory: (
            email: EmailProcessor,
            push: PushNotificationProcessor,
          ) => [email, push],
          inject: [EmailProcessor, PushNotificationProcessor],
        },
      ],
      exports: [
        BulkActionService,
        FairQueueService,
        BackpressureService,
        ReadyQueueService,
        CongestionControlService,
        WorkerPoolService,
        AggregatorService,
        DistributedLockService,
        ReliableQueueService,
        InFlightQueueService,
        DeadLetterService,
        IdempotencyService,
      ],
    };
  }

  static registerProcessors(processors: any[]): DynamicModule {
    return {
      module: BulkActionModule,
      providers: [
        {
          provide: JOB_PROCESSOR,
          useFactory: (...instances: any[]) => instances,
          inject: processors,
        },
        ...processors,
      ],
      exports: [JOB_PROCESSOR],
    };
  }

  static registerAggregators(aggregators: any[]): DynamicModule {
    return {
      module: BulkActionModule,
      providers: [
        {
          provide: AGGREGATOR,
          useFactory: (defaultAgg: DefaultAggregator, ...custom: any[]) => [
            defaultAgg,
            ...custom,
          ],
          inject: [DefaultAggregator, ...aggregators],
        },
        DefaultAggregator,
        ...aggregators,
      ],
      exports: [AGGREGATOR],
    };
  }
}
