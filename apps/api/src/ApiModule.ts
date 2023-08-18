import { Module } from '@nestjs/common';
import { getRealDBModule } from '@app/entity/getRealDBModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';
import { NotificationModule } from './notification/NotificationModule';
import { LoggerModule } from '@app/logger/LoggerModule';

@Module({
  imports: [
    getRealDBModule(),
    LoggerModule,
    Configuration.getModule(),
    BuyerModule,
    NotificationModule,
  ],
})
export class ApiModule {}
