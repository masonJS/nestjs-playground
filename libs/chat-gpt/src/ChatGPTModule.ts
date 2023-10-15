import { Module } from '@nestjs/common';
import { OpenAI } from 'openai';
import { ConfigService } from '@nestjs/config';
import { Environment } from '@app/config/env/Environment';
import { ChatGPTService } from '@app/chat-gpt/ChatGPTService';

@Module({
  providers: [
    ChatGPTService,
    {
      provide: OpenAI,
      useFactory: (configService: ConfigService<Environment>) => {
        const openAi = configService.get('chatGPT', {
          infer: true,
        });

        return new OpenAI({
          apiKey: openAi?.apiKey,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [ChatGPTService],
})
export class ChatGPTModule {}
