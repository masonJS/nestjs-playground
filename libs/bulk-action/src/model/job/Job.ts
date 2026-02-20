import { JobPayload } from '@app/bulk-action/model/job/type/JobPayload';
import { JobStatus } from '@app/bulk-action/model/job/type/JobStatus';

export class Job<T = Record<string, unknown>> {
  id: string;
  groupId: string;
  processorType: string;
  payload: JobPayload<T>;
  status: JobStatus;
  retryCount: number;
  createdAt: number; // milliseconds since epoch

  constructor(jobData: Record<string, string> | undefined) {
    if (!jobData) {
      throw new Error('Job data is undefined');
    }

    this.id = jobData.id;
    this.groupId = jobData.groupId;
    this.processorType = jobData.processorType ?? '';
    this.payload = JSON.parse(jobData.payload) ?? {};
    this.status = (jobData.status as JobStatus) ?? JobStatus.PENDING;
    this.retryCount = parseInt(jobData.retryCount ?? '0', 10);
    this.createdAt = parseInt(jobData.createdAt ?? '0', 10);
  }
}
