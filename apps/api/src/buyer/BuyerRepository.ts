import { Buyer } from '@app/entity/domain/buyer/Buyer';
import { Repository } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

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
