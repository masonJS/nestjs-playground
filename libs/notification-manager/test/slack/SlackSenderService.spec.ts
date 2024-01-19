import { SlackSenderService } from '@app/notification-manager/slack/SlackSenderService';
import { Test } from '@nestjs/testing';
import { WebClientService } from '@app/web-client/creator/WebClientService';
import { LoggerModule } from '@app/logger/LoggerModule';
import { HttpStatus } from '@nestjs/common';
import { SlackSenderDto } from '@app/notification-manager/slack/dto/SlackSenderDto';
import { TestWebClientService } from '../../../web-client/test/creator/TestWebClientService';
import { StubWebClient } from '../../../web-client/test/StubWebClient';

describe('SlackSenderService', () => {
  let slackSenderService: SlackSenderService;
  const stubWebClient = StubWebClient.getInstance();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule],
      providers: [
        SlackSenderService,
        {
          provide: WebClientService,
          useClass: TestWebClientService,
        },
      ],
    }).compile();

    slackSenderService = module.get(SlackSenderService);
  });

  beforeEach(() => stubWebClient.clear());

  describe('send', () => {
    it('슬랙 일림 전송 성공시 ok를 반환한다.', async () => {
      // given
      stubWebClient.addResponse('ok', HttpStatus.OK);
      const dto = SlackSenderDto.of('url', []);

      // when
      const result = await slackSenderService.send(dto);

      // then
      expect(result).toBe('ok');
    });
  });
});
