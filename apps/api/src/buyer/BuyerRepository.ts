import { EntityManager, Repository } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';

@Injectable()
export class BuyerRepository {
  constructor(
    @InjectRepository(Buyer)
    private readonly buyerRepository: Repository<Buyer>,
    @InjectEntityManager()
    private readonly manager: EntityManager,
  ) {}

  async create(buyer: Buyer): Promise<void> {
    await this.buyerRepository.save(buyer);
  }

  async updateAndReturnAccessCount(id: number) {
    return await this.manager
      .createQueryBuilder()
      .update(Buyer)
      .set({ accessCount: () => 'access_count + 1' })
      .where('id = :id', { id })
      .returning('*')
      .execute()
      .then((result: { raw: { access_count: number }[] }) =>
        result.raw[0] ? result.raw[0].access_count : 0,
      );
  }
}
