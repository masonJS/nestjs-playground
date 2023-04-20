import { Repository } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';

@Injectable()
export class BuyerRepository {
  constructor(
    @InjectRepository(Buyer)
    private readonly buyerRepository: Repository<Buyer>,
  ) {}
  async create(buyer: Buyer): Promise<void> {
    await this.buyerRepository.save(buyer);
  }
}
