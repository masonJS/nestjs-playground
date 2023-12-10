import { ESlackNotifySender } from '@app/notification-manager/slack/enum/ESlackNotifySender';

describe('ESlackNotifySender', () => {
  it('HELLO_SLACK', () => {
    // given
    const data = {
      text: 'text',
      buttonText: 'buttonText',
      buttonLink: 'buttonLink',
    };

    // when
    const dto = ESlackNotifySender.HELLO_SLACK.toSenderDto(data);

    // then
    expect(dto).toMatchInlineSnapshot(`
      SlackSenderDto {
        "_blocks": [
          SlackTextBlockDto {
            "_text": "text",
          },
          SlackButtonBlockDto {
            "_link": "buttonLink",
            "_text": "buttonText",
          },
        ],
        "_url": "https://hooks.slack.com/services/test/XXXXX",
      }
    `);
  });
});
