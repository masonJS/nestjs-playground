import { Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@app/logger/Logger';
import { S3UploadFileRequest } from '@app/file-storage/dto/S3UploadFileRequest';
import { S3UploadFileResponse } from '@app/file-storage/dto/S3UploadFileResponse';
import { S3Error } from '@app/file-storage/error/S3Error';
import { S3DownloadFileResponse } from '@app/file-storage/dto/S3DownloadFileResponse';

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
      this.logger.error(
        `s3 file upload error: input = ${JSON.stringify(input)}, message = ${
          e.message
        }`,
        e,
      );
      throw e;
    }
  }

  async download(
    bucket: string,
    path: string,
  ): Promise<S3DownloadFileResponse> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: path,
    });

    try {
      return await this.getFileToS3(command);
    } catch (e) {
      this.logger.error(
        `s3 file download error: bucket&path = ${JSON.stringify({
          bucket,
          path,
        })} message = ${e.message}`,
        e,
      );

      throw new S3Error(e.message);
    }
  }

  private async putFileToS3(command: PutObjectCommand) {
    const response = await this.s3Client
      .send(command)
      .then((res) => new S3UploadFileResponse(res));

    if (response.isNotOK) {
      throw new Error(`s3 file upload error: message = ${response.message}`);
    }
  }

  private async getFileToS3(
    command: GetObjectCommand,
  ): Promise<S3DownloadFileResponse> {
    const response = await this.s3Client
      .send(command)
      .then((output) => new S3DownloadFileResponse(output));

    if (response.isNotOK || !response.body) {
      throw new Error(`s3 file download error: message = ${response.message}`);
    }

    return response;
  }
}
