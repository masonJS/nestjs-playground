import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@app/logger/Logger';
import { S3UploadFileRequest } from '@app/file-storage/dto/S3UploadFileRequest';
import { S3UploadFileResponse } from '@app/file-storage/dto/S3UploadFileResponse';

@Injectable()
export class FileStorageService {
  constructor(
    private readonly s3Client: S3Client,
    private readonly logger: Logger,
  ) {}

  async upload(input: S3UploadFileRequest) {
    try {
      const command = new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.path,
        ContentType: input.contentType,
        Body: input.data,
      });

      await this.putFileToS3(command);
    } catch (e) {
      this.logger.info('test3');
      this.logger.error(`s3 file upload error `, e);
      throw e;
    }
  }

  private async putFileToS3(command: PutObjectCommand) {
    const response = await this.s3Client
      .send(command)
      .then((res) => new S3UploadFileResponse(res));

    if (response.isNotOK) {
      throw new Error(`s3 file upload error: message = ${response.message}`);
      throw new Error(`s3 file upload error: message = ${response.message}`);
    }
  }
}
