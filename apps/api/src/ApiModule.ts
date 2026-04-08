import { Module } from '@nestjs/common';
import { getRealDBModule } from '@app/entity/getRealDBModule';
import { Configuration } from '@app/config/Configuration';
import { LoggerModule } from '@app/logger/LoggerModule';
import { TelemetryModule } from '@app/telemetry/TelemetryModule';
import { CryptoModule } from '@app/crypto/CryptoModule';
import { NotificationManagerModule } from '@app/notification-manager/NotificationManagerModule';
import { NotificationModule } from './notification/NotificationModule';
import { BuyerModule } from './buyer/BuyerModule';
import { BulkActionApiModule } from './bulk-action/BulkActionApiModule';

@Module({
  imports: [
    getRealDBModule(),
    LoggerModule,
    Configuration.getModule(),
    TelemetryModule,
    BuyerModule,
    NotificationModule,
    CryptoModule,
    NotificationManagerModule,
    BulkActionApiModule,
  ],
})
export class ApiModule {}
