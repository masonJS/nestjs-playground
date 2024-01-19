import { Readable } from 'stream';
import { FileStorageService } from '@app/file-storage/FileStorageService';
import { getFileStorageModule } from '@app/file-storage/getFileStorageModule';
import { Test } from '@nestjs/testing';
import { LoggerModule } from '@app/logger/LoggerModule';
import { S3UploadFileRequest } from '@app/file-storage/dto/S3UploadFileRequest';

describe('FileStorageService', () => {
  let fileStorageService: FileStorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [getFileStorageModule(), LoggerModule],
    }).compile();

    fileStorageService = module.get<FileStorageService>(FileStorageService);
  });

  describe('upload', () => {
    it('잘못된 버킷 경로로 업로드시 오류가 발생한다.', async () => {
      const dto = new S3UploadFileRequest(
        'invalid-bucket',
        'file-name',
        'text',
        'content',
      );

      const result = fileStorageService.upload(dto);

      await expect(result).rejects.toThrowError(
        'The specified bucket does not exist',
      );
    });

    it('파일을 업로드 한다.', async () => {
      const dto = new S3UploadFileRequest(
        'test-bucket',
        'file-name',
        'text',
        Readable.from(['test']),
      );

      await fileStorageService.upload(dto);
    });
  });
});
