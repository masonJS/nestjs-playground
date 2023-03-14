import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Generated,
  PrimaryColumn,
} from 'typeorm';
import { LocalDateTime } from '@js-joda/core';
import { LocalDateTimeTransformer } from '@app/entity/transformer/LocalDateTimeTransformer';
import { BigintTransformer } from '@app/entity/transformer/BigintTransformer';

export abstract class BaseEntity {
  @Generated('increment')
  @PrimaryColumn({ type: 'bigint', transformer: new BigintTransformer() })
  id: number;

  @Column({
    type: 'timestamptz',
    transformer: new LocalDateTimeTransformer(),
    update: false,
  })
  createdAt: LocalDateTime;

  @Column({
    type: 'timestamptz',
    transformer: new LocalDateTimeTransformer(),
  })
  updatedAt: LocalDateTime;

  @BeforeInsert()
  protected beforeInsert() {
    this.createdAt = LocalDateTime.now();
    this.updatedAt = LocalDateTime.now();
  }

  @BeforeUpdate()
  protected beforeUpdate() {
    this.updatedAt = LocalDateTime.now();
  }
}
