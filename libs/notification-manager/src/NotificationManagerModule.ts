import { Module } from '@nestjs/common';
import { SlackSenderService } from '@app/notification-manager/slack/SlackSenderService';

@Module({
  imports: [],
  providers: [SlackSenderService],
  exports: [SlackSenderService],
})
export class NotificationManagerModule {}
