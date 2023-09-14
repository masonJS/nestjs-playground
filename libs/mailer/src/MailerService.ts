import { SESClientService } from '@app/mailer/SESClientService';
import { Injectable } from '@nestjs/common';
import { SendEmailDto } from '@app/mailer/SendEmailDto';

@Injectable()
export class MailerService {
  constructor(private readonly sesClientService: SESClientService) {}

  async send(
    from: string,
    to: string,
    subject: string,
    content: string,
    cc?: string[],
  ): Promise<void> {
    await this.sesClientService.send(
      new SendEmailDto(from, to, subject, content, cc).commandInput,
    );
  }
}
