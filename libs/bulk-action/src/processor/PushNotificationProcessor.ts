import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../model/job/Job';
import { JobProcessorResponse } from '../model/job-processor/dto/JobProcessorResponse';
import { JobProcessor } from '../model/job-processor/JobProcessor';

@Injectable()
export class PushNotificationProcessor implements JobProcessor {
  readonly type = 'PUSH_NOTIFICATION';

  private readonly logger = new Logger(PushNotificationProcessor.name);

  async process(job: Job): Promise<JobProcessorResponse> {
    const payload = job.payload as {
      deviceToken: string;
      title: string;
      message: string;
    };

    this.logger.debug(
      `Sending push to ${payload.deviceToken}: "${payload.title}"`,
    );

    // TODO: 실제 푸시 발송 로직 (FCM, APNs 등)

    return {
      jobId: job.id,
      groupId: job.groupId,
      success: true,
      data: { deviceToken: payload.deviceToken, title: payload.title },
      durationMs: 0,
    };
  }
}
