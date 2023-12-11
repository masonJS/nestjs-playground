import { Module } from '@nestjs/common';
import { getRealDBModule } from '@app/entity/getRealDBModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';
import { NotificationModule } from './notification/NotificationModule';
import { LoggerModule } from '@app/logger/LoggerModule';
import { CryptoModule } from '@app/crypto/CryptoModule';
import { NotificationManagerModule } from '@app/notification-manager/NotificationManagerModule';

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
