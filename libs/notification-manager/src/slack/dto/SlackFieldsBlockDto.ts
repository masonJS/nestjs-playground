import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';

export class SlackFieldsBlockDto extends SlackTemplate {
  private readonly _fields: Record<'name' | 'value', string>[];

  constructor(fields: Record<'name' | 'value', string>[]) {
    super();
    this._fields = fields;
  }

  message() {
    return {
      type: 'section',
      fields: this._fields.map((field) => ({
        type: 'mrkdwn',
        text: `*${field.name}*\n${field.value}`,
      })),
    };
  }
}
