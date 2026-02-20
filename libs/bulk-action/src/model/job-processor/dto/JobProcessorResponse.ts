export interface JobProcessorResponse {
  jobId: string;
  groupId: string;
  success: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
    retryable: boolean;
  };
  durationMs: number;
}
