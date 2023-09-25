import { RequestDto } from '../../decorator/RequestDto';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsPositiveInt } from '../../decorator/validate/IsPositiveInt';

@RequestDto()
export class SliceRequest {
  @ApiProperty({ type: Number })
  static DEFAULT_SLICE_SIZE = 10;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsPositiveInt()
  sliceSize: number = SliceRequest.DEFAULT_SLICE_SIZE;

  @ApiProperty({ type: Number, required: false })
  @Type(() => Number)
  @IsPositiveInt()
  lastId?: number;

  get limit(): number {
    if (!this.sliceSize) {
      return SliceRequest.DEFAULT_SLICE_SIZE;
    }

    return this.sliceSize + 1;
  }
}
