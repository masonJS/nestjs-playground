import { Module } from '@nestjs/common';
import { getPgRealTypeOrmModule } from '@app/entity/getRealTypeOrmModule';
import { Configuration } from '@app/config/Configuration';

@Module({
  imports: [getPgRealTypeOrmModule(), Configuration.getModule()],
  controllers: [],
  providers: [],
})
export class ApiModule {}
