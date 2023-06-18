import { EventPublisherService } from '@app/event-publisher/EventPublisherService';
import { Global, Module } from '@nestjs/common';
import { SNSClient } from '@aws-sdk/client-sns';
import { ConfigService } from '@nestjs/config';
import { Environment } from '@app/config/env/Environment';
import { SnsEnvironment } from '@app/config/env/SnsEnvironment';

@Global()
@Module({
  providers: [
    EventPublisherService,
    {
      provide: SNSClient,
      useFactory: (config: ConfigService<Environment>) => {
        const snsEnv: SnsEnvironment = config.get('sns')!;

        return new SNSClient(snsEnv.toSNSClientConfig());
      },
      inject: [ConfigService],
    },
  ],
  exports: [EventPublisherService],
})
export class EventPublisherModule {}
