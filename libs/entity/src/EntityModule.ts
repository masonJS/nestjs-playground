import { Module } from '@nestjs/common';
import { BuyerEntity } from '@app/entity/domain/buyer/Buyer.entity';

@Module({
  imports: [BuyerEntity],
})
export class EntityModule {}
