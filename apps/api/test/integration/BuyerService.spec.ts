import { BuyerFactory } from '../../../../libs/entity/test/factory/BuyerFactory';
import { Test } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { BuyerService } from '../../src/buyer/BuyerService';
import { getTestModule } from '../../../../libs/web-common/test/unit/getTestModule';
import { getRealDBModule } from '@app/entity/getRealDBModule';

describe('BuyerService', () => {
  let service: BuyerService;
  let buyerFactory: BuyerFactory;

  beforeAll(async () => {
    const module = await Test.createTestingModule(
      getTestModule(BuyerService, {
        imports: [getRealDBModule()],
      }),
    ).compile();

    const em = module.get(EntityManager);
    service = module.get(BuyerService);
    buyerFactory = new BuyerFactory(em);
  });

  beforeEach(async () => {
    await buyerFactory.clear();
  });

  it('updateAccess success', async () => {
    // given
    const buyer = await buyerFactory.save({
      accessCount: 0,
    });

    // when, then
    await Promise.all([
      service.updateAccess(buyer.id),
      service.updateAccess(buyer.id),
    ]);
  });

  it('updateAccess fail', async () => {
    // given
    const buyer = await buyerFactory.save({
      accessCount: 0,
    });

    // when
    const result = async () =>
      Promise.all([
        service.updateAccess(buyer.id),
        service.updateAccess(buyer.id),
        service.updateAccess(buyer.id),
      ]);

    // then
    await expect(result()).rejects.toThrowError('Access limit exceeded');
  });
});
