import { Injectable } from '@nestjs/common';
import { WebClientService } from '@app/web-client/creator/WebClientService';
import { Logger } from '@app/logger/Logger';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { SlackSenderDto } from '@app/notification-manager/slack/dto/SlackSenderDto';

@Injectable()
export class SlackSenderService {
  constructor(
    private readonly logger: Logger,
    private readonly webClientService: WebClientService,
  ) {}

  async send(dto: SlackSenderDto): Promise<string> {
    try {
      const spec = await this.webClientService
        .create(dto.url)
        .post()
        .body(BodyInserter.fromJSON(dto.message))
        .retrieve();

      return spec.rawBody;
    } catch (e) {
      this.logger.error(
        `Slack send error url=${dto.url}, message=${JSON.stringify(
          dto.message,
        )}`,
        e,
      );
      throw new Error(e);
    }
  }
}
