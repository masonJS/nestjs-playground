import { PutObjectCommandInputType } from '@aws-sdk/client-s3/dist-types/commands/PutObjectCommand';

export class S3UploadFileRequest {
  private readonly _bucket: string;

  private readonly _path: string;

  private readonly _contentType: string;

  private readonly _data: PutObjectCommandInputType['Body'];

  constructor(
    bucket: string,
    path: string,
    contentType: string,
    data: PutObjectCommandInputType['Body'],
  ) {
    this._bucket = bucket;
    this._path = path;
    this._contentType = contentType;
    this._data = data;
  }

  get bucket(): string {
    return this._bucket;
  }

  get path(): string {
    return this._path;
  }

  get contentType(): string {
    return this._contentType;
  }

  get data(): PutObjectCommandInputType['Body'] {
    return this._data;
  }
}
