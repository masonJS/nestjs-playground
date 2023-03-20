import { Body, Controller, Post } from '@nestjs/common';
import { BuyerCreateRequest } from './dto/BuyerCreateRequest';
import { BuyerService } from './BuyerService';

@Controller('v1/buyer')
export class BuyerController {
  constructor(private readonly buyerService: BuyerService) {}

  @Post()
  async create(@Body() request: BuyerCreateRequest) {
    try {
      await this.buyerService.create(request);

      return 'success';
    } catch (e) {
      return e.message;
    }
  }
}
