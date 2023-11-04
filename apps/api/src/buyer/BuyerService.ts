import { Injectable } from '@nestjs/common';
import { BuyerCreateRequest } from './dto/BuyerCreateRequest';
import { BuyerRepository } from './BuyerRepository';

@Injectable()
export class BuyerService {
  protected readonly LIMIT_ACCESS_COUNT = 2;

  constructor(private readonly buyerRepository: BuyerRepository) {}

  async create(request: BuyerCreateRequest) {
    await this.buyerRepository.create(request.toEntity());
  }

  async updateAccess(id: number) {
    const accessCount = await this.buyerRepository.updateAndReturnAccessCount(
      id,
    );

    if (accessCount > this.LIMIT_ACCESS_COUNT) {
      throw new Error('Access limit exceeded');
    }

    return accessCount;
  }
}
