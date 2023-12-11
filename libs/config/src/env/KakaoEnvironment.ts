import { IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BizMessageEnvironment } from '@app/config/env/BizMessageEnvironment';

export class KakaoEnvironment {
  @ValidateNested()
  @IsNotEmpty()
  @Type(() => BizMessageEnvironment)
  bizMessage: BizMessageEnvironment;
}
