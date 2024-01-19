import { DeepPartial } from 'typeorm';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';
import { BaseFactory } from './BaseFactory';

export class BuyerFactory extends BaseFactory<Buyer> {
  override entity = Buyer;

  toEntity(entity?: DeepPartial<Buyer>): Buyer {
    return Object.assign(new Buyer(), {
      ...this.fakeColumns(Buyer),
      ...entity,
    });
  }

  override makeOne(entity?: DeepPartial<Buyer>): Buyer {
    return this.toEntity(entity);
  }
}
