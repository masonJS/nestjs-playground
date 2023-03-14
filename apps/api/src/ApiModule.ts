import { Module } from '@nestjs/common';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';

@Module({
  imports: [getPgRealTypeOrmModule()],
  controllers: [],
  providers: [],
})
export class ApiModule {}
