import { Injectable } from '@nestjs/common';
import {
  SendEmailCommand,
  SendEmailCommandInput,
  SESClient,
} from '@aws-sdk/client-ses';
import { SESResponse } from '@app/mailer/SESResponse';
import { Logger } from '@app/logger/Logger';

@Injectable()
export class SESClientService {
  constructor(
    private readonly sesClient: SESClient,
    private readonly logger: Logger,
  ) {}

  async send(commandInput: SendEmailCommandInput) {
    try {
      await this.sendSESCommand(new SendEmailCommand(commandInput));
    } catch (e) {
      this.logger.error(
        `메일 전송 실패 - 발송대상: ${JSON.stringify(commandInput)} 사유: ${
          e.message
        }`,
        e,
      );
      throw e;
    }
  }

  private async sendSESCommand(command: SendEmailCommand) {
    const response = await this.sesClient
      .send(command)
      .then((output) => new SESResponse(output));

    if (response.isNotOK()) {
      throw new Error(
        `ses send result is not ok: message = ${response.message}`,
      );
    }
  }
}
