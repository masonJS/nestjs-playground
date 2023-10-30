import { IsNumber, IsString } from 'class-validator';

export class CachingCMMEnvironment {
  @IsString()
  kmsKeyArn: string;

  @IsNumber()
  cacheCapacity: number;

  @IsNumber()
  maxAge: number;

  @IsString()
  get keyId(): string {
    return this.kmsKeyArn;
  }
}
