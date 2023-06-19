import { PutObjectCommandOutput } from '@aws-sdk/client-s3';

export class S3UploadFileResponse {
  readonly output: PutObjectCommandOutput;

  constructor(output: PutObjectCommandOutput) {
    this.output = output;
  }

  get isNotOK(): boolean {
    return this.output.$metadata.httpStatusCode !== 200;
  }

  get message(): string {
    return JSON.stringify({
      statusCode: this.output.$metadata.httpStatusCode,
      requestId: this.output.$metadata.requestId,
    });
  }
}
