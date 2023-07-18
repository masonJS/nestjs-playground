import { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export class S3DownloadFileResponse {
  private readonly _output: GetObjectCommandOutput;

  constructor(output: GetObjectCommandOutput) {
    this._output = output;
  }

  get isNotOK(): boolean {
    return this._output.$metadata.httpStatusCode !== 200;
  }

  get body(): Readable {
    if (!(this._output.Body instanceof Readable)) {
      throw new Error(`s3 file download error: message = ${this.message}`);
    }

    return this._output.Body;
  }

  get message() {
    return JSON.stringify({
      statusCode: this._output.$metadata.httpStatusCode,
      requestId: this._output.$metadata.requestId,
    });
  }

  async fileBuffer(): Promise<Buffer> {
    const fileStream = this._output.Body as Readable;

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      fileStream.on('data', (chunk) => chunks.push(chunk));
      fileStream.once('end', () => resolve(Buffer.concat(chunks)));
      fileStream.once('error', reject);
    });
  }
}
