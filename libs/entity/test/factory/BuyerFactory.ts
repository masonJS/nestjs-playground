import { BaseFactory } from './BaseFactory';
import { BuyerEntity } from '@app/entity/domain/buyer/Buyer.entity';
import { DeepPartial } from 'typeorm';

export class BuyerFactory extends BaseFactory<BuyerEntity> {
  override entity = BuyerEntity;

  toEntity(entity: DeepPartial<BuyerEntity>): BuyerEntity {
    return Object.assign(new BuyerEntity(), {
      ...this.fakeColumns(BuyerEntity),
      ...entity,
    });
  }
}
