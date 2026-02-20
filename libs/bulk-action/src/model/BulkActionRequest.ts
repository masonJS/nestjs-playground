import { JobPayload } from '@app/bulk-action/model/job/type/JobPayload';
import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';

export interface BulkActionRequest<T = Record<string, unknown>> {
  jobGroupId: string;
  jobId: string;
  jobProcessorType: string;
  payload: JobPayload<T>;
  basePriority?: number; // default: 0
  priorityLevel?: PriorityLevel; // default: NORMAL
}
