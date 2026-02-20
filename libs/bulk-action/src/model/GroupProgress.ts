import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';

export interface GroupProgress {
  groupId: string;
  totalJobs: number;
  doneJobs: number;
  pendingInQueue: number;
  progressPercent: number;
  status: string;
  congestion: {
    level: string;
    nonReadyCount: number;
    lastBackoffMs: number;
  };
}

export interface SubmitBulkJobsRequest {
  groupId: string;
  processorType: string;
  jobs: Array<{ jobId: string; payload: Record<string, unknown> }>;
  basePriority?: number;
  priorityLevel?: PriorityLevel;
}
