import { Column, Entity } from 'typeorm';
import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { BaseEntity } from '@app/entity/domain/BaseEntity';

@Entity()
export class Buyer extends BaseEntity {
  @Column('varchar', { length: 255 })
  email: string;

  @Column('varchar', { length: 255 })
  password: string;

  @Column('varchar', { length: 255 })
  name: string;

  @Column('varchar', { length: 5 })
  countryNumber: string;

  @Column('varchar', { length: 20 })
  phoneNumber: string;

  @Column('varchar', { length: 20 })
  receiveAlarmType: ReceiveAlarmType;
}
