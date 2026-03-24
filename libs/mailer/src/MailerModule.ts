import { Global, Module } from '@nestjs/common';
import { SESClient } from '@aws-sdk/client-ses';
import { ConfigService } from '@nestjs/config';
import { Environment } from '@app/config/env/Environment';
import { SesEnvironment } from '@app/config/env/SesEnvironment';
import { SESClientService } from '@app/mailer/SESClientService';
import { MailerService } from '@app/mailer/MailerService';

@Global()
@Module({
  providers: [
    SESClientService,
    MailerService,
    {
      provide: SESClient,
      useFactory: (config: ConfigService<Environment>) => {
        const sesEnv: SesEnvironment = config.get('ses')!;

        return new SESClient(sesEnv.toSESClientConfig());
      },
      inject: [ConfigService],
    },
  ],
  exports: [SESClientService, MailerService],
})
export class MailerModule {}
