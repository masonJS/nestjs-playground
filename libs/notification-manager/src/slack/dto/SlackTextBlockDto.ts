import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';

export class SlackTextBlockDto extends SlackTemplate {
  private readonly _text: string;

  constructor(text: string) {
    super();
    this._text = text;
  }

  message(): Record<string, unknown> {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: this._text,
      },
    };
  }
}
