import { BuyerFactory } from '../../../../libs/entity/test/factory/BuyerFactory';
import { Test } from '@nestjs/testing';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';
import { EntityModule } from '@app/entity/EntityModule';
import { EntityManager } from 'typeorm';
import { BuyerRepository } from '../../src/buyer/BuyerRepository';
import { Buyer } from '@app/entity/domain/buyer/Buyer';
import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';

describe('BuyerRepository', () => {
  let buyerRepository: BuyerRepository;
  let buyerFactory: BuyerFactory;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [getPgRealTypeOrmModule(), EntityModule],
      providers: [BuyerRepository],
    }).compile();

    const em = module.get(EntityManager);
    buyerRepository = module.get(BuyerRepository);
    buyerFactory = new BuyerFactory(em);
  });

  beforeEach(async () => buyerFactory.clear());

  it('test', async () => {
    // given
    const buyer = Buyer.create(
      'email',
      'password',
      'name',
      '82',
      '01012345678',
      ReceiveAlarmType.ALL,
    );

    // when
    await buyerRepository.create(buyer);

    // then
    const result = await buyerFactory.findOne({ where: { id: buyer.id } });
    expect(result.email).toBe('email');
  });
});
