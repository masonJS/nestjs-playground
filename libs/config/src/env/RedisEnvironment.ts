import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RedisEnvironment {
  @IsNotEmpty()
  @IsString()
  host: string;

  @IsNotEmpty()
  @IsInt()
  port: number;

  @IsOptional()
  @IsString()
  password?: string;

  @IsNotEmpty()
  @IsInt()
  db: number;
}
