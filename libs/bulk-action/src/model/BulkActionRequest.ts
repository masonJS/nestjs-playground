import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';

export interface BulkActionRequest {
  groupId: string;
  jobId: string;
  jobProcessorType: string;
  payload: Record<string, unknown>;
  basePriority?: number; // default: 0
  priorityLevel?: PriorityLevel; // default: NORMAL
}
