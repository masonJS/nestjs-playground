import { Module } from '@nestjs/common';
import { BulkActionModule } from '@app/bulk-action/BulkActionModule';
import { Configuration } from '@app/config/Configuration';
import { BulkActionController } from './BulkActionController';

const env = Configuration.getEnv();

@Module({
  imports: [
    BulkActionModule.register({
      redis: {
        host: env.redis.host,
        port: env.redis.port,
        password: env.redis.password,
        db: env.redis.db,
        keyPrefix: 'bulk-action:',
      },
    }),
  ],
  controllers: [BulkActionController],
})
export class BulkActionApiModule {}
