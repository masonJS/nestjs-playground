import { IsString } from 'class-validator';

export class ChatGPTEnvironment {
  @IsString()
  apiKey: string;
}
