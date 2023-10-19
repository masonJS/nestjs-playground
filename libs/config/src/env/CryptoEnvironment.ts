import { IsString } from 'class-validator';

export class CryptoEnvironment {
  @IsString()
  symmetricKey: string;
}
