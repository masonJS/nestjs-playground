import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';

export class BuyerCreateRequestDtoV2 {
  email: string;

  password: string;

  name: string;

  countryNumber: string;

  phoneNumber: string;

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
