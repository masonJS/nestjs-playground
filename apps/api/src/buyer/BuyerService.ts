import { Injectable } from '@nestjs/common';
import { BuyerCreateRequestDto } from './dto/BuyerCreateRequest.dto';
import { BuyerRepository } from './BuyerRepository';

@Injectable()
export class BuyerService {
  constructor(private readonly buyerRepository: BuyerRepository) {}

  async create(request: BuyerCreateRequestDto) {
    await this.buyerRepository.create(request.toEntity());
  }
}
