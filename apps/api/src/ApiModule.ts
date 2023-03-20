import { Module } from '@nestjs/common';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';
import { Configuration } from '@app/config/Configuration';
import { BuyerModule } from './buyer/BuyerModule';

@Module({
  imports: [getPgRealTypeOrmModule(), Configuration.getModule(), BuyerModule],
})
export class ApiModule {}
