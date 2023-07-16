import { Module } from '@nestjs/common';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';
import { NotificationModule } from './notification/NotificationModule';

@Module({
  imports: [
    getPgRealTypeOrmModule(),
    Configuration.getModule(),
    BuyerModule,
    NotificationModule,
  ],
})
export class ApiModule {}
