import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';

export class SubmitJobRequest {
  @IsNotEmpty()
  @IsString()
  jobGroupId: string;

  @IsNotEmpty()
  @IsString()
  jobId: string;

  @IsNotEmpty()
  @IsString()
  jobProcessorType: string;

  @IsNotEmpty()
  @IsObject()
  payload: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  basePriority?: number;

  @IsOptional()
  @IsEnum(PriorityLevel)
  priorityLevel?: PriorityLevel;
}
