import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { JobProcessor } from '../model/job-processor/JobProcessor';

@Injectable()
export class EmailProcessor implements JobProcessor {
  readonly type = 'SEND_EMAIL';

  private readonly logger = new Logger(EmailProcessor.name);

  async process(job: Job): Promise<JobProcessorResponse> {
    const payload = job.payload as {
      to: string;
      subject: string;
      body: string;
    };

    this.logger.debug(`Sending email to ${payload.to}: "${payload.subject}"`);

    // TODO: 실제 이메일 발송 로직 (SES, SMTP 등)

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      data: { to: payload.to, subject: payload.subject },
      durationMs: 0,
    };
  }
}
