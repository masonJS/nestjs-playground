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
import { EventEmitterService } from '@app/event-emitter/EventEmitterService';
import { BuyerFindOneEvent } from './event/BuyerFindOneEvent';
import { ApiOperation } from '@nestjs/swagger';

@Controller('buyer')
export class BuyerController implements OnApplicationShutdown {
  constructor(
    private readonly buyerService: BuyerService,
    private readonly eventEmitterService: EventEmitterService,
  ) {}

  @Post()
  @Version('1')
  @ApiOperation({ summary: '' })
  async create(@Body() request: BuyerCreateRequest) {
    try {
      await this.buyerService.create(request);

      return 'success';
    } catch (e) {
      return e.message;
    }
  }

  @Get()
  @ApiOperation({ summary: '' })
  async findOne() {
    this.eventEmitterService.raise(new BuyerFindOneEvent('event test'));
    return 'success';
  }

  @ApiOperation({ summary: '' })
  onApplicationShutdown(): any {
    // db connection close
    // app connection close
  }
}
