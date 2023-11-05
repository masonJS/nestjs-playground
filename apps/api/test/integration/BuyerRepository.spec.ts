import { BuyerFactory } from '../../../../libs/entity/test/factory/BuyerFactory';
import { Test } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { BuyerRepository } from '../../src/buyer/BuyerRepository';
import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';
import { getTestModule } from '../../../../libs/web-common/test/unit/getTestModule';
import { getRealDBModule } from '@app/entity/getRealDBModule';

describe('BuyerRepository', () => {
  let buyerRepository: BuyerRepository;
  let buyerFactory: BuyerFactory;

  beforeAll(async () => {
    const module = await Test.createTestingModule(
      getTestModule(BuyerRepository, {
        imports: [getRealDBModule()],
      }),
    ).compile();

    const em = module.get(EntityManager);
    buyerRepository = module.get(BuyerRepository);
    buyerFactory = new BuyerFactory(em);
  });

  beforeEach(async () => buyerFactory.clear());

  it('create Test', async () => {
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

  it('createOrUpdate Test', async () => {
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
    await Promise.all([
      buyerRepository.createOrUpdate(buyer),
      buyerRepository.createOrUpdate(buyer),
    ]);

    // then
    const result = await buyerFactory.entityManager.count(Buyer);
    expect(result).toBe(1);
  });

  it('updateAccessCount Test', async () => {
    // given
    const buyer = await buyerFactory.save({
      accessCount: 11,
    });

    // when
    const result = await buyerRepository.updateAndReturnAccessCount(buyer.id);

    // then
    expect(result).toBe(11 + 1);
  });
});
