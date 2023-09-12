import { IsBoolean, IsString } from 'class-validator';

export class S3Environment {
  @IsString()
  region: string;

  @IsString()
  endpoint: string;

  @IsString()
  credentialsAccessKey: string;

  @IsString()
  credentialsKeyId: string;

  @IsBoolean()
  forcePathStyle: boolean;

  toConfig() {
    return {
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        secretAccessKey: this.credentialsAccessKey,
        accessKeyId: this.credentialsKeyId,
      },
      forcePathStyle: this.forcePathStyle,
    };
  }
}
