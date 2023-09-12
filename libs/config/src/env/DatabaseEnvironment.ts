import { IsInt, IsNotEmpty, IsString } from 'class-validator';

export class DatabaseEnvironment {
  @IsNotEmpty()
  @IsString()
  masterHost: string;

  @IsNotEmpty()
  @IsString()
  readerHost: string;

  @IsNotEmpty()
  @IsInt()
  port: number;

  @IsNotEmpty()
  @IsString()
  user: string;

  @IsNotEmpty()
  @IsString()
  password: string;

  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsInt()
  connectTimeoutMS: number;

  @IsNotEmpty()
  @IsInt()
  statementTimeout: number;

  @IsNotEmpty()
  @IsInt()
  idleInTransactionSessionTimeout: number;
}
