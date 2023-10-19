import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { Environment } from '@app/config/env/Environment';
import { SymEncryptionService } from '@app/crypto/symmetric-encryption/SymEncryptionService';

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
  ],
  exports: [SymEncryptionService],
})
export class CryptoModule {}
