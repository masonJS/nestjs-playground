import { Job } from '../job/Job';
import { JobProcessorResponse } from './dto/JobProcessorResponse';

export interface JobProcessor {
  readonly type: string;

  process(job: Job): Promise<JobProcessorResponse>;
}

export const JOB_PROCESSOR = Symbol('JOB_PROCESSOR');
