import { RequestDto } from '../../decorator/RequestDto';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

@RequestDto()
export class SliceRequest {
  @ApiProperty({ type: Number })
  static DEFAULT_SLICE_SIZE = 10;

  @Type(() => Number)
  @ApiProperty({ type: Number })
  sliceSize: number = SliceRequest.DEFAULT_SLICE_SIZE;

  @Type(() => Number)
  @ApiProperty({ type: Number, required: false })
  lastId?: number;

  get limit(): number {
    if (!this.sliceSize) {
      return SliceRequest.DEFAULT_SLICE_SIZE;
    }

    return this.sliceSize + 1;
  }
}
