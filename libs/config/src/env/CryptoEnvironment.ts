import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CachingCMMEnvironment } from '@app/config/env/CachingCMMEnvironment';

export class CryptoEnvironment {
  @IsString()
  symmetricKey: string;

  @ValidateNested()
  @IsNotEmpty()
  @Type(() => CachingCMMEnvironment)
  cacheCMM: CachingCMMEnvironment;
}
