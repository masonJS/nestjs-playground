import { Configuration } from '@app/config/Configuration';
import {
  BulkActionConfig,
  DEFAULT_FAIR_QUEUE_CONFIG,
  DEFAULT_BACKPRESSURE_CONFIG,
  DEFAULT_CONGESTION_CONFIG,
  DEFAULT_WORKER_POOL_CONFIG,
  DEFAULT_AGGREGATOR_CONFIG,
  DEFAULT_WATCHER_CONFIG,
  DEFAULT_RELIABLE_QUEUE_CONFIG,
} from '@app/bulk-action/config/BulkActionConfig';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export const TEST_KEY_PREFIX = 'test:';

export function createTestBulkActionConfig(
  overrides?: DeepPartial<Omit<BulkActionConfig, 'redis'>>,
): BulkActionConfig {
  const env = Configuration.getEnv();

  return {
    redis: {
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      db: env.redis.db,
      keyPrefix: TEST_KEY_PREFIX,
    },
    fairQueue: {
      ...DEFAULT_FAIR_QUEUE_CONFIG,
      ...overrides?.fairQueue,
    },
    backpressure: {
      ...DEFAULT_BACKPRESSURE_CONFIG,
      ...overrides?.backpressure,
    },
    congestion: {
      ...DEFAULT_CONGESTION_CONFIG,
      ...overrides?.congestion,
    },
    workerPool: {
      ...DEFAULT_WORKER_POOL_CONFIG,
      ...overrides?.workerPool,
    },
    aggregator: {
      ...DEFAULT_AGGREGATOR_CONFIG,
      ...overrides?.aggregator,
    },
    watcher: {
      ...DEFAULT_WATCHER_CONFIG,
      ...overrides?.watcher,
    },
    reliableQueue: {
      ...DEFAULT_RELIABLE_QUEUE_CONFIG,
      ackTimeoutMs: 5000,
      orphanRecoveryIntervalMs: 100,
      orphanRecoveryBatchSize: 50,
      workerPollIntervalMs: 50,
      ...overrides?.reliableQueue,
    },
  };
}
