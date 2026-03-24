import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { FileStorageService } from '@app/file-storage/FileStorageService';
import { getFileStorageModule } from '@app/file-storage/getFileStorageModule';
import { Test } from '@nestjs/testing';
import { LoggerModule } from '@app/logger/LoggerModule';
import { S3UploadFileRequest } from '@app/file-storage/dto/S3UploadFileRequest';
import { S3Error } from '@app/file-storage/error/S3Error';

const BUCKET = 'test-bucket';

describe('FileStorageService', () => {
  let fileStorageService: FileStorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [getFileStorageModule(), LoggerModule],
    }).compile();

    fileStorageService = module.get<FileStorageService>(FileStorageService);
  });

  function uniqueKey(prefix = 'test'): string {
    return `${prefix}/${randomUUID()}`;
  }

  describe('upload', () => {
    it('존재하지 않는 버킷으로 업로드시 오류가 발생한다.', async () => {
      const dto = new S3UploadFileRequest(
        'invalid-bucket',
        'file-name',
        'text/plain',
        'content',
      );

      await expect(fileStorageService.upload(dto)).rejects.toThrow();
    });

    it('문자열 데이터를 업로드한다.', async () => {
      const key = uniqueKey();
      const content = 'hello localstack';

      await fileStorageService.upload(
        new S3UploadFileRequest(BUCKET, key, 'text/plain', content),
      );

      const downloaded = await fileStorageService.download(BUCKET, key);
      const buffer = await downloaded.fileBuffer();

      expect(buffer.toString()).toBe(content);
    });

    it('스트림 데이터를 업로드한다.', async () => {
      const key = uniqueKey();
      const content = 'stream content test';

      await fileStorageService.upload(
        new S3UploadFileRequest(
          BUCKET,
          key,
          'text/plain',
          Readable.from([content]),
        ),
      );

      const downloaded = await fileStorageService.download(BUCKET, key);
      const buffer = await downloaded.fileBuffer();

      expect(buffer.toString()).toBe(content);
    });

    it('JSON 데이터를 업로드한다.', async () => {
      const key = uniqueKey();
      const json = { name: 'test', value: 123 };

      await fileStorageService.upload(
        new S3UploadFileRequest(
          BUCKET,
          key,
          'application/json',
          JSON.stringify(json),
        ),
      );

      const downloaded = await fileStorageService.download(BUCKET, key);
      const buffer = await downloaded.fileBuffer();

      expect(JSON.parse(buffer.toString())).toEqual(json);
    });
  });

  describe('download', () => {
    it('존재하지 않는 파일을 다운로드하면 S3Error가 발생한다.', async () => {
      await expect(
        fileStorageService.download(BUCKET, 'non-existent-key'),
      ).rejects.toThrow(S3Error);
    });

    it('다운로드한 파일의 body를 Readable 스트림으로 읽을 수 있다.', async () => {
      const key = uniqueKey();
      const content = 'readable stream test';

      await fileStorageService.upload(
        new S3UploadFileRequest(BUCKET, key, 'text/plain', content),
      );

      const downloaded = await fileStorageService.download(BUCKET, key);
      const body = downloaded.body;

      expect(body).toBeInstanceOf(Readable);

      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks).toString()).toBe(content);
    });
  });
});
