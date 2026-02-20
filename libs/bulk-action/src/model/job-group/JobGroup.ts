import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';
import { GroupStatus } from '@app/bulk-action/model/job-group/type/GroupStatus';

export interface JobGroup {
  groupId: string;
  basePriority: number;
  totalJobs: number;
  doneJobs: number;
  priorityLevel: PriorityLevel;
  createdAt: number;
  status: GroupStatus;
}

export type JobGroupHash = Record<keyof JobGroup, string>;
