import { Configuration } from '@app/config/Configuration';
import { FileStorageModule } from '@app/file-storage/FileStorageModule';

export function getFileStorageModule() {
  const s3Env = Configuration.getEnv().s3;

  return FileStorageModule.register(s3Env.toConfig());
}
