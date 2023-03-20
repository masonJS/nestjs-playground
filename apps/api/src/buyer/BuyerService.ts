import { Injectable } from '@nestjs/common';
import { BuyerCreateRequest } from './dto/BuyerCreateRequest';
import { BuyerRepository } from './BuyerRepository';

@Injectable()
export class BuyerService {
  constructor(private readonly buyerRepository: BuyerRepository) {}

  async create(request: BuyerCreateRequest) {
    await this.buyerRepository.create(request.toEntity());
  }
}
