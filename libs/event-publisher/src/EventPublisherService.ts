import { Injectable } from '@nestjs/common';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { Logger } from '@app/logger/Logger';

@Injectable()
export class EventPublisherService {
  constructor(
    private readonly snsClient: SNSClient,
    private readonly logger: Logger,
  ) {}

  async publish(topicArn: string, message: string): Promise<void> {
    try {
      const command = new PublishCommand({
        TopicArn: topicArn,
        Message: message,
      });

      await this.snsClient.send(command);
    } catch (e) {
      this.logger.error(
        `EventPublisherService publish Exception: topicArn=${topicArn}, message=${message}`,
        e,
      );

      throw e;
    }
  }
}
