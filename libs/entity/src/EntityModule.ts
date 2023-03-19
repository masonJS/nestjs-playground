import { Module } from '@nestjs/common';
import { Buyer } from '@app/entity/domain/buyer/Buyer';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([Buyer])],
  exports: [TypeOrmModule],
})
export class EntityModule {}
