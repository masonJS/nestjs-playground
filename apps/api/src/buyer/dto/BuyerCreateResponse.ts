import { ApiProperty } from '@nestjs/swagger';

export class BuyerCreateResponse {
  id: number;

  @ApiProperty()
  get name(): string | undefined {
    return 'name';
  }

  @ApiProperty()
  get email(): string {
    return 'email';
  }
}
