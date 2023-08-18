import { Test } from '@nestjs/testing';
import { EntityModule } from '@app/entity/EntityModule';
import { BuyerFactory } from './factory/BuyerFactory';
import { EntityManager } from 'typeorm';
import { getRealDBModule } from '@app/entity/getRealDBModule';

describe('BuyerFactory', () => {
  let buyerFactory: BuyerFactory;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [getRealDBModule(), EntityModule],
    }).compile();

    const em = module.get(EntityManager);
    buyerFactory = new BuyerFactory(em);
  });

  it('test', async () => {
    // given, when
    const buyer = await buyerFactory.save({
      countryNumber: '82',
    });

    // then
    expect(buyer.countryNumber).toBe('82');
  });
});
