import { Test } from '@nestjs/testing';
import { Configuration } from '@app/config/Configuration';
import { EventPublisherModule } from '@app/event-publisher/EventPublisherModule';
import { LoggerModule } from '@app/logger/LoggerModule';
import { EventPublisherService } from '@app/event-publisher/EventPublisherService';
import {
  SQSClient,
  ReceiveMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';

const TOPIC_ARN = 'arn:aws:sns:ap-northeast-2:000000000000:test-topic';
const QUEUE_URL = 'http://localhost:4568/000000000000/test-queue';

describe('EventPublisherService', () => {
  let eventPublisherService: EventPublisherService;
  let sqsClient: SQSClient;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [Configuration.getModule(), EventPublisherModule, LoggerModule],
    }).compile();

    eventPublisherService = module.get<EventPublisherService>(
      EventPublisherService,
    );

    sqsClient = new SQSClient({
      region: 'ap-northeast-2',
      endpoint: 'http://localhost:4568',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  beforeEach(async () => {
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL }));
  });

  afterAll(() => {
    sqsClient.destroy();
  });

  it('유효하지 않은 sns topic일 경우 에러를 발생한다.', async () => {
    const result = eventPublisherService.publish('invalid-topic', 'message');

    await expect(result).rejects.toThrow();
  });

  it('문자열 메시지를 발행하면 SQS 구독자가 수신한다.', async () => {
    // given
    const message = 'hello localstack';

    // when
    await eventPublisherService.publish(TOPIC_ARN, message);

    // then
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        WaitTimeSeconds: 5,
        MaxNumberOfMessages: 1,
      }),
    );

    expect(response.Messages).toHaveLength(1);

    const body = JSON.parse(response.Messages![0].Body!);
    expect(body.Message).toBe(message);
  });

  it('JSON 메시지를 발행하면 SQS 구독자가 동일한 내용을 수신한다.', async () => {
    // given
    const payload = {
      userId: 1,
      event: 'USER_CREATED',
      data: { name: 'test' },
    };
    const message = JSON.stringify(payload);

    // when
    await eventPublisherService.publish(TOPIC_ARN, message);

    // then
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        WaitTimeSeconds: 5,
        MaxNumberOfMessages: 1,
      }),
    );

    expect(response.Messages).toHaveLength(1);

    const body = JSON.parse(response.Messages![0].Body!);
    expect(JSON.parse(body.Message)).toEqual(payload);
  });

  it('여러 메시지를 발행하면 모두 SQS에 도달한다.', async () => {
    // given
    const messages = ['message-1', 'message-2', 'message-3'];

    // when
    for (const msg of messages) {
      await eventPublisherService.publish(TOPIC_ARN, msg);
    }

    // then - SQS는 한 번의 receive로 모든 메시지를 반환하지 않을 수 있으므로 반복 polling
    const received: string[] = [];
    const maxAttempts = 5;

    for (let i = 0; i < maxAttempts && received.length < messages.length; i++) {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          WaitTimeSeconds: 3,
          MaxNumberOfMessages: 10,
        }),
      );

      if (response.Messages) {
        for (const m of response.Messages) {
          received.push(JSON.parse(m.Body!).Message);
        }
      }
    }

    expect(received.sort()).toEqual(messages);
  });
});
