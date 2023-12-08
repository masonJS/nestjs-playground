import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';

export class SlackSenderDto {
  private readonly _url: string;
  private readonly _blocks: SlackTemplate[];

  constructor(url: string, blocks: SlackTemplate[]) {
    this._url = url;
    this._blocks = blocks;
  }

  static of(url: string, blocks: SlackTemplate[]) {
    return new SlackSenderDto(url, blocks);
  }

  get url(): string {
    return this._url;
  }

  get message() {
    return {
      attachments: [
        {
          color: '#FFFFFF',
          blocks: this._blocks.map((b) => b.message()),
        },
      ],
    };
  }
}
