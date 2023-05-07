import { Body, Controller, Post, Version } from '@nestjs/common';
import { BuyerCreateRequestDto } from './dto/BuyerCreateRequest.dto';
import { BuyerService } from './BuyerService';
import { BuyerCreateRequestDtoV2 } from './dto/BuyerCreateRequestV2.dto';

@Controller('buyer')
export class BuyerController {
  constructor(private readonly buyerService: BuyerService) {}

  @Post()
  @Version('1')
  async create(@Body() request: BuyerCreateRequestDto) {
    try {
      await this.buyerService.create(request);

      return 'success';
    } catch (e) {
      return e.message;
    }
  }

  @Post()
  @Version('2')
  async createV2(@Body() request: BuyerCreateRequestDtoV2) {
    try {
      await this.buyerService.create(request);

      return 'success';
    } catch (e) {
      return e.message;
    }
  }
}
