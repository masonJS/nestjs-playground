import { BaseFactory } from './BaseFactory';
import { Buyer } from '@app/entity/domain/buyer/Buyer';
import { DeepPartial } from 'typeorm';

export class BuyerFactory extends BaseFactory<Buyer> {
  override entity = Buyer;

  toEntity(entity: DeepPartial<Buyer>): Buyer {
    return Object.assign(new Buyer(), {
      ...this.fakeColumns(Buyer),
      ...entity,
    });
  }
}
