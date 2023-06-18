import { Test } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { EventPublisherModule } from '@app/event-publisher/EventPublisherModule';
import { LoggerModule } from '@app/logger/LoggerModule';
import { EventPublisherService } from '@app/event-publisher/EventPublisherService';

describe('EventPublisherService', () => {
  let eventPublisherService: EventPublisherService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [Configuration.getModule(), EventPublisherModule, LoggerModule],
      providers: [],
    }).compile();

    eventPublisherService = module.get<EventPublisherService>(
      EventPublisherService,
    );
  });

  it('유효하지 않은 sns topic일 경우 에러를 발생한다.', async () => {
    // given
    const topic = 'invalid-topic';
    const message = 'test message';

    // when
    const result = eventPublisherService.publish(topic, message);

    // then
    await expect(result).rejects.toThrow('Topic does not exist');
  });

  it('메시지를 발행한다.', async () => {
    // given
    const topic = 'arn:aws:sns:ap-northeast-2:000000000000:test-topic';
    const message = 'test message';

    // when, then
    await eventPublisherService.publish(topic, message);
  });
});
