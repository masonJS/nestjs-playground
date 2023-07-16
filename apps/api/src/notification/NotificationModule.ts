import { Module } from '@nestjs/common';
import { NotificationListener } from './NotificationListener';

@Module({
  providers: [NotificationListener],
})
export class NotificationModule {}
