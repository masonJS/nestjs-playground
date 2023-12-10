import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';

export class SlackButtonBlockDto extends SlackTemplate {
  private readonly _link: string;
  private readonly _text: string;

  constructor(text: string, link: string) {
    super();
    this._text = text;
    this._link = link;
  }

  message() {
    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: this._text,
            emoji: true,
          },
          url: this._link,
        },
      ],
    };
  }
}
