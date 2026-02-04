import { PriorityLevel } from './JobGroup';

export interface EnqueueOptions {
  groupId: string;
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  basePriority?: number; // default: 0
  priorityLevel?: PriorityLevel; // default: NORMAL
}
