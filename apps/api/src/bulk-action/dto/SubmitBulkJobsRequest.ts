import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PriorityLevel } from '@app/bulk-action/model/job-group/type/PriorityLevel';

class BulkJobItemRequest {
  @IsNotEmpty()
  @IsString()
  jobId: string;

  @IsNotEmpty()
  @IsObject()
  payload: Record<string, unknown>;
}

export class SubmitBulkJobsRequest {
  @IsNotEmpty()
  @IsString()
  groupId: string;

  @IsNotEmpty()
  @IsString()
  processorType: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkJobItemRequest)
  jobs: BulkJobItemRequest[];

  @IsOptional()
  @IsInt()
  basePriority?: number;

  @IsOptional()
  @IsEnum(PriorityLevel)
  priorityLevel?: PriorityLevel;
}
