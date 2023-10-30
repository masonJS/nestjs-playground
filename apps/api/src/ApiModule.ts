import { Module } from '@nestjs/common';
import { getRealDBModule } from '@app/entity/getRealDBModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';
import { NotificationModule } from './notification/NotificationModule';
import { LoggerModule } from '@app/logger/LoggerModule';
import { CryptoModule } from '@app/crypto/CryptoModule';

@Module({
  imports: [
    getRealDBModule(),
    LoggerModule,
    Configuration.getModule(),
    BuyerModule,
    NotificationModule,
    CryptoModule,
  ],
})
export class ApiModule {}
