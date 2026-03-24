import { Test } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { MailerModule } from '@app/mailer/MailerModule';
import { LoggerModule } from '@app/logger/LoggerModule';
import { SESClientService } from '@app/mailer/SESClientService';
import { SendEmailCommandInput } from '@aws-sdk/client-ses';

const VERIFIED_EMAIL = 'test@test.com';
const SES_MESSAGES_API = 'http://localhost:4568/_aws/ses/';

interface SesMessage {
  Id: string;
  Source: string;
  Subject: string;
  Destination: { ToAddresses: string[] };
  Body: { text_part: string | null; html_part: string | null };
}

async function fetchSentMessages(): Promise<SesMessage[]> {
  const response = await fetch(SES_MESSAGES_API);
  const data = await response.json();

  return data.messages;
}

async function clearSentMessages(): Promise<void> {
  await fetch(SES_MESSAGES_API, { method: 'DELETE' });
}

function createCommandInput(
  overrides: Partial<{
    from: string;
    to: string;
    subject: string;
    body: string;
  }> = {},
): SendEmailCommandInput {
  return {
    Source: overrides.from ?? VERIFIED_EMAIL,
    Destination: {
      ToAddresses: [overrides.to ?? VERIFIED_EMAIL],
    },
    Message: {
      Subject: { Data: overrides.subject ?? 'test subject', Charset: 'UTF-8' },
      Body: {
        Html: { Data: overrides.body ?? '<p>test body</p>', Charset: 'UTF-8' },
      },
    },
  };
}

describe('SESClientService', () => {
  let sesClientService: SESClientService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [Configuration.getModule(), MailerModule, LoggerModule],
    }).compile();

    sesClientService = module.get<SESClientService>(SESClientService);
  });

  beforeEach(async () => {
    await clearSentMessages();
  });

  it('인증되지 않은 발신자로 메일 전송시 에러가 발생한다.', async () => {
    const input = createCommandInput({ from: 'unknown@invalid.com' });

    await expect(sesClientService.send(input)).rejects.toThrow();
  });

  it('메일을 전송하면 발송 내역에 기록된다.', async () => {
    // given
    const input = createCommandInput();

    // when
    await sesClientService.send(input);

    // then
    const messages = await fetchSentMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0].Source).toBe(VERIFIED_EMAIL);
    expect(messages[0].Destination.ToAddresses).toEqual([VERIFIED_EMAIL]);
    expect(messages[0].Subject).toBe('test subject');
    expect(messages[0].Body.html_part).toBe('<p>test body</p>');
  });

  it('HTML 본문이 포함된 메일을 전송하면 HTML 내용이 그대로 기록된다.', async () => {
    // given
    const htmlBody = '<h1>Hello</h1><p>HTML content</p>';
    const input = createCommandInput({
      subject: 'HTML 테스트',
      body: htmlBody,
    });

    // when
    await sesClientService.send(input);

    // then
    const messages = await fetchSentMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0].Subject).toBe('HTML 테스트');
    expect(messages[0].Body.html_part).toBe(htmlBody);
  });

  it('여러 수신자에게 메일을 전송하면 모든 수신자가 기록된다.', async () => {
    // given
    const recipients = ['recipient1@test.com', 'recipient2@test.com'];
    const input: SendEmailCommandInput = {
      Source: VERIFIED_EMAIL,
      Destination: { ToAddresses: recipients },
      Message: {
        Subject: { Data: '다중 수신자 테스트', Charset: 'UTF-8' },
        Body: {
          Html: { Data: '<p>multi recipients</p>', Charset: 'UTF-8' },
        },
      },
    };

    // when
    await sesClientService.send(input);

    // then
    const messages = await fetchSentMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0].Destination.ToAddresses).toEqual(recipients);
    expect(messages[0].Subject).toBe('다중 수신자 테스트');
  });
});
