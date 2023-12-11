import { IsString } from 'class-validator';

export class BizMessageEnvironment {
  @IsString()
  senderKey: string;

  @IsString()
  appKey: string;

  @IsString()
  secretKey: string;

  get alimtalkEndpoint(): string {
    return `https://api-alimtalk.cloud.toast.com/alimtalk/v2.2/appkeys/${this.appKey}/messages`;
  }
}
