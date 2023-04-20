import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { BuyerEntity } from '@app/entity/domain/buyer/Buyer.entity';

export class BuyerCreateRequest {
  email: string;

  password: string;

  name: string;

  countryNumber: string;

  phoneNumber: string;

  receiveAlarmType: ReceiveAlarmType;

  toEntity(): BuyerEntity {
    return BuyerEntity.create(
      this.email,
      this.password,
      this.name,
      this.countryNumber,
      this.phoneNumber,
      this.receiveAlarmType,
    );
  }
}
