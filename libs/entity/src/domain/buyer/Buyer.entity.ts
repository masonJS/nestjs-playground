import { Column, Entity, Unique } from 'typeorm';
import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { BaseEntity } from '@app/entity/domain/BaseEntity';
import { JsonTransformer } from '@app/entity/transformer/JsonTransformer';
import { Phone } from '@app/entity/domain/buyer/Phone';

@Entity()
@Unique(['email'])
export class Buyer extends BaseEntity {
  @Column('varchar', { length: 255 })
  email: string;

  @Column('varchar', { length: 255 })
  password: string;

  @Column('varchar', { length: 255 })
  name: string;

  @Column({
    type: 'jsonb',
    default: {},
    comment: '휴대폰 번호',
    transformer: new JsonTransformer(Phone),
  })
  phone: Phone;

  @Column('varchar', { length: 20 })
  receiveAlarmType: ReceiveAlarmType;

  @Column('int', { default: 0 })
  accessCount: number;

  static create(
    email: string,
    password: string,
    name: string,
    countryNumber: string,
    phoneNumber: string,
    receiveAlarmType: ReceiveAlarmType,
  ): Buyer {
    const buyer = new Buyer();
    buyer.email = email;
    buyer.password = password;
    buyer.name = name;
    buyer.phone = Phone.create(countryNumber, phoneNumber);
    buyer.receiveAlarmType = receiveAlarmType;

    return buyer;
  }
}
