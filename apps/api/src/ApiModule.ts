import { Module } from '@nestjs/common';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';
import { NotificationModule } from './notification/NotificationModule';
import { LoggerModule } from '@app/logger/LoggerModule';

@Module({
  imports: [
    getPgRealTypeOrmModule(),
    LoggerModule,
    Configuration.getModule(),
    BuyerModule,
    NotificationModule,
  ],
})
export class ApiModule {}
