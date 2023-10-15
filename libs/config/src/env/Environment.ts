import { IsNotEmpty, ValidateNested } from 'class-validator';
import { DatabaseEnvironment } from './DatabaseEnvironment';
import { Type } from 'class-transformer';
import { SnsEnvironment } from '@app/config/env/SnsEnvironment';
import { S3Environment } from '@app/config/env/S3Environment';
import { ChatGPTEnvironment } from '@app/config/env/ChatGPTEnvironment';

export class Environment {
  @ValidateNested()
  @IsNotEmpty()
  @Type(() => DatabaseEnvironment)
  database: DatabaseEnvironment;

  @ValidateNested()
  @IsNotEmpty()
  @Type(() => SnsEnvironment)
  sns: SnsEnvironment;

  @ValidateNested()
  @IsNotEmpty()
  @Type(() => S3Environment)
  s3: S3Environment;

  @ValidateNested()
  @IsNotEmpty()
  @Type(() => ChatGPTEnvironment)
  chatGPT: ChatGPTEnvironment;
}
