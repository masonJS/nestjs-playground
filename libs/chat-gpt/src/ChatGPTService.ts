import { Injectable } from '@nestjs/common';
import { OpenAI } from 'openai';
import { ChatGPTRequest } from '@app/chat-gpt/dto/ChatGPTRequest';
import { Logger } from '@app/logger/Logger';
import { ChatGPTResponse } from '@app/chat-gpt/dto/ChatGPTResponse';

@Injectable()
export class ChatGPTService {
  constructor(
    private readonly openAI: OpenAI,
    private readonly logger: Logger,
  ) {}

  async resolve(request: ChatGPTRequest) {
    try {
      return await this.resolveByChat(request.toBody);
    } catch (e) {
      this.logger.error(
        `open ai chat completion error: request=${JSON.stringify({
          request,
        })} message=${e.message}`,
        e,
      );

      throw new Error(e.message);
    }
  }

  private async resolveByChat(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  ) {
    const response = await this.openAI.chat.completions
      .create(body)
      .then((res) => new ChatGPTResponse(res.choices[0].message.content));

    if (response.isNoMessage) {
      throw new Error(`open ai chat completion no response message`);
    }
  }
}
