import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';
import { ApiProperty } from '@nestjs/swagger';

export class BuyerCreateRequestDto {
  @ApiProperty()
  email: string;

  @ApiProperty()
  password: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  countryNumber: string;

  @ApiProperty()
  phoneNumber: string;

  @ApiProperty()
  receiveAlarmType: ReceiveAlarmType;

  toEntity(): Buyer {
    return Buyer.create(
      this.email,
      this.password,
      this.name,
      this.countryNumber,
      this.phoneNumber,
      this.receiveAlarmType,
    );
  }
}
