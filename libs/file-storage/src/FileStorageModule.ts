import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { FileStorageService } from '@app/file-storage/FileStorageService';
import { DynamicModule } from '@nestjs/common';

export class FileStorageModule {
  static register(s3Config: S3ClientConfig): DynamicModule {
    return {
      module: FileStorageModule,
      providers: [
        FileStorageService,
        { provide: S3Client, useValue: new S3Client(s3Config) },
      ],
      exports: [FileStorageService],
    };
  }
}
