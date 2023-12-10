import { ESlackSender } from '@app/notification-manager/slack/enum/ESlackSender';
import { SlackTemplate } from '@app/notification-manager/slack/interface/SlackTemplate';
import { SlackTextBlockDto } from '@app/notification-manager/slack/dto/SlackTextBlockDto';
import { SlackButtonBlockDto } from '@app/notification-manager/slack/dto/SlackButtonBlockDto';

export class ESlackNotifySender<
  T extends (a: any) => SlackTemplate[] = () => [],
> extends ESlackSender<T> {
  static readonly HELLO_SLACK = new ESlackNotifySender(
    'Hello Slack',
    'https://hooks.slack.com/services/XXXXX',
    (data: { text: string; buttonText: string; buttonLink: string }) => [
      new SlackTextBlockDto(data.text),
      new SlackButtonBlockDto(data.buttonText, data.buttonLink),
    ],
  );

  constructor(_channel: string, _webhook: string, _slackTemplates: T) {
    super(_channel, _webhook, _slackTemplates);
  }
}
