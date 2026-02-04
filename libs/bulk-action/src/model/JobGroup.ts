export interface JobGroup {
  groupId: string;
  basePriority: number;
  totalJobs: number;
  doneJobs: number;
  priorityLevel: PriorityLevel;
  createdAt: number;
  status: GroupStatus;
}

export enum PriorityLevel {
  HIGH = 'high',
  NORMAL = 'normal',
  LOW = 'low',
}

export enum GroupStatus {
  CREATED = 'CREATED',
  DISPATCHED = 'DISPATCHED',
  RUNNING = 'RUNNING',
  AGGREGATING = 'AGGREGATING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
