import { IsString } from 'class-validator';
import { SNSClientConfig } from '@aws-sdk/client-sns';

export class SnsEnvironment {
  @IsString()
  region: string;

  @IsString()
  endpoint: string;

  @IsString()
  credentialsAccessKey: string;

  @IsString()
  credentialsKeyId: string;

  @IsString()
  arnTopic: string;

  toSNSClientConfig(): SNSClientConfig {
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
