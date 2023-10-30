import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { Environment } from '@app/config/env/Environment';
import { SymEncryptionService } from '@app/crypto/symmetric-encryption/SymEncryptionService';
import {
  getLocalCryptographicMaterialsCache,
  KmsKeyringNode,
  NodeCachingMaterialsManager,
} from '@aws-crypto/client-node';

const cacheCMMProvider = {
  provide: NodeCachingMaterialsManager,
  useFactory: (configService: ConfigService<Environment>) => {
    const cacheCMM = configService.get('crypto.cacheCMM', {
      infer: true,
    });

    if (!cacheCMM) {
      throw new Error('no cacheCMM provided');
    }

    return new NodeCachingMaterialsManager({
      backingMaterials: new KmsKeyringNode({
        generatorKeyId: cacheCMM.keyId,
      }),
      cache: getLocalCryptographicMaterialsCache(cacheCMM.cacheCapacity),
      maxAge: cacheCMM.maxAge,
    });
  },
  inject: [ConfigService],
};

@Module({
  providers: [
    {
      provide: SymEncryptionService,
      useFactory: (configService: ConfigService<Environment>) =>
        new SymEncryptionService(
          configService.get('crypto.symmetricKey', '', { infer: true }),
        ),
      inject: [ConfigService],
    },
    cacheCMMProvider,
  ],
  exports: [SymEncryptionService],
})
export class CryptoModule {}
