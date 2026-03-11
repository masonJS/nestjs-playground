import { Body, Controller, Get, Param, Post, Version } from '@nestjs/common';
import { BulkActionService } from '@app/bulk-action/BulkActionService';
import { SubmitJobRequest } from './dto/SubmitJobRequest';
import { SubmitBulkJobsRequest } from './dto/SubmitBulkJobsRequest';

@Controller('bulk-action')
export class BulkActionController {
  constructor(private readonly bulkActionService: BulkActionService) {}

  @Post('job')
  @Version('1')
  async submitJob(@Body() request: SubmitJobRequest) {
    await this.bulkActionService.submitJob(request);

    return {
      submitted: true,
      jobId: request.jobId,
      groupId: request.jobGroupId,
    };
  }

  @Post('jobs')
  @Version('1')
  async submitBulkJobs(@Body() request: SubmitBulkJobsRequest) {
    const submittedJobs = await this.bulkActionService.submitBulkJobs(request);

    return {
      submittedJobs,
      groupId: request.groupId,
    };
  }

  @Get('job/:jobId')
  @Version('1')
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.bulkActionService.getJobStatus(jobId);
  }

  @Get('group/:groupId/progress')
  @Version('1')
  async getGroupProgress(@Param('groupId') groupId: string) {
    return this.bulkActionService.getGroupProgress(groupId);
  }

  @Get('group/:groupId/result')
  @Version('1')
  async getGroupResult(@Param('groupId') groupId: string) {
    return this.bulkActionService.getGroupResult(groupId);
  }

  @Get('group/:groupId/aggregator-progress')
  @Version('1')
  async getAggregatorProgress(@Param('groupId') groupId: string) {
    return this.bulkActionService.getAggregatorProgress(groupId);
  }

  @Get('queue-depths')
  @Version('1')
  async getQueueDepths() {
    return this.bulkActionService.getQueueDepths();
  }

  @Get('pool-status')
  @Version('1')
  async getPoolStatus() {
    return this.bulkActionService.getPoolStatus();
  }
}
