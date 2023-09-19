import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class PageRequest {
  private static DEFAULT_PAGE_NUMBER = 1;
  private static DEFAULT_PAGE_SIZE = 10;

  @ApiProperty({ required: true, example: PageRequest.DEFAULT_PAGE_NUMBER })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNumber = PageRequest.DEFAULT_PAGE_NUMBER;

  @ApiProperty({ required: true, example: PageRequest.DEFAULT_PAGE_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize = PageRequest.DEFAULT_PAGE_SIZE;

  get offset(): number {
    const pageNumber = this.pageNumber || PageRequest.DEFAULT_PAGE_NUMBER;

    return (pageNumber - 1) * this.limit;
  }

  get limit(): number {
    return !this.pageSize ? PageRequest.DEFAULT_PAGE_SIZE : this.pageSize;
  }
}
