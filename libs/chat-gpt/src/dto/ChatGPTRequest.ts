import { OpenAI } from 'openai';

export class ChatGPTRequest {
  private readonly requestParams = {
    model: 'gpt-3.5-turbo-16k',
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  constructor(private readonly input: string) {}

  static from(input: string): ChatGPTRequest {
    return new ChatGPTRequest(input);
  }

  get toBody(): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    return {
      messages: [
        {
          role: 'user',
          content: this.input,
        },
      ],
      ...this.requestParams,
    };
  }
}
