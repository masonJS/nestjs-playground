import { Module } from '@nestjs/common';
import { getRealDBModule } from '@app/entity/getRealDBModule';
import { Configuration } from '@app/config/Configuration';
import { LoggerModule } from '@app/logger/LoggerModule';
import { CryptoModule } from '@app/crypto/CryptoModule';
import { NotificationManagerModule } from '@app/notification-manager/NotificationManagerModule';
import { NotificationModule } from './notification/NotificationModule';
import { BuyerModule } from './buyer/BuyerModule';

@Module({
  imports: [
    getRealDBModule(),
    LoggerModule,
    Configuration.getModule(),
    BuyerModule,
    NotificationModule,
    CryptoModule,
    NotificationManagerModule,
  ],
})
export class ApiModule {}
