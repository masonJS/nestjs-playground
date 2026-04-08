import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class OtelEnvironment {
  @IsNotEmpty()
  @IsBoolean()
  enabled: boolean;

  @IsNotEmpty()
  @IsString()
  exporterOtlpEndpoint: string;

  @IsNotEmpty()
  @IsString()
  serviceName: string;
}
