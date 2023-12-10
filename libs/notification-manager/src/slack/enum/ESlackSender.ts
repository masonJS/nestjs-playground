import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';
import { SlackSenderDto } from '@app/notification-manager/slack/dto/SlackSenderDto';

export abstract class ESlackSender<
  T extends (a: any) => SlackTemplate[] = () => [],
> {
  static TEST_WEBHOOK_URL = 'https://hooks.slack.com/services/test/XXXXX';

  protected constructor(
    readonly _channel: string,
    readonly _webhook: string,
    readonly _slackTemplates: T,
  ) {}

  webHookUrl(env = process.env.NODE_ENV): string {
    return env === 'production' ? this._webhook : ESlackSender.TEST_WEBHOOK_URL;
  }

  toSenderDto(data: Parameters<T>[0], webhookUrl?: string): SlackSenderDto {
    return SlackSenderDto.of(
      webhookUrl || this.webHookUrl(),
      this._slackTemplates(data),
    );
  }

  get channel(): string {
    return this._channel;
  }
}
