import { IsString } from 'class-validator';
import { SESClientConfig } from '@aws-sdk/client-ses';

export class SesEnvironment {
  @IsString()
  region: string;

  @IsString()
  endpoint: string;

  @IsString()
  credentialsAccessKey: string;

  @IsString()
  credentialsKeyId: string;

  toSESClientConfig(): SESClientConfig {
    return {
      region: this.region,
      credentials: {
        secretAccessKey: this.credentialsAccessKey,
        accessKeyId: this.credentialsKeyId,
      },
      endpoint: this.endpoint,
    };
  }
}
