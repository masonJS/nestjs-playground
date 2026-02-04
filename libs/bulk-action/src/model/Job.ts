export interface Job {
  id: string;
  groupId: string;
  type: string;
  payload: string; // JSON string
  status: JobStatus;
  retryCount: number;
  createdAt: number;
}

export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
