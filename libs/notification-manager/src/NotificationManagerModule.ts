import { Module } from '@nestjs/common';
import { SlackSenderService } from '@app/notification-manager/slack/SlackSenderService';
import { Environment } from '@app/config/env/Environment';
import { ConfigService } from '@nestjs/config';
import { KakaoSenderService } from '@app/notification-manager/kakao/KakaoSenderService';
import { WebClientModule } from '@app/web-client/WebClientModule';

@Module({
  imports: [WebClientModule],
  providers: [
    SlackSenderService,
    KakaoSenderService,
    {
      provide: 'CONFIG',
      useFactory: (configService: ConfigService<Environment>) => {
        const env = configService.get('kakao.bizMessage', { infer: true });
        if (!env) {
          return;
        }

        return env;
      },
      inject: [ConfigService],
    },
  ],
  exports: [SlackSenderService],
})
export class NotificationManagerModule {}
