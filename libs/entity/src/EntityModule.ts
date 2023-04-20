import { Module } from '@nestjs/common';
import { Buyer } from '@app/entity/domain/buyer/Buyer.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([Buyer])],
  exports: [TypeOrmModule],
})
export class EntityModule {}
