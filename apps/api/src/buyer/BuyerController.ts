import {
  Body,
  Controller,
  Get,
  OnApplicationShutdown,
  Post,
  Version,
} from '@nestjs/common';
import { BuyerCreateRequest } from './dto/BuyerCreateRequest';
import { BuyerService } from './BuyerService';

@Controller('buyer')
export class BuyerController implements OnApplicationShutdown {
  constructor(private readonly buyerService: BuyerService) {}

  @Post()
  @Version('1')
  async create(@Body() request: BuyerCreateRequest) {
    try {
      await this.buyerService.create(request);

      return 'success';
    } catch (e) {
      return e.message;
    }
  }

  @Get()
  async findOne() {
    await new Promise((resolve) => setTimeout(resolve, 7000));
    console.log('success');
    return 'success';
  }

  onApplicationShutdown(signal?: string): any {
    console.log(signal);
    // db connection close
    // app connection close
  }
}
