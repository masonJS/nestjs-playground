import {
  buildClient,
  CommitmentPolicy,
  NodeCachingMaterialsManager,
} from '@aws-crypto/client-node';
import { Injectable } from '@nestjs/common';
import { Logger } from '@app/logger/Logger';

@Injectable()
export class EnvelopeEncryptionService {
  private readonly client = buildClient(
    CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT,
  );

  constructor(
    private readonly cachingCMM: NodeCachingMaterialsManager,
    private readonly logger: Logger,
  ) {}

  async encrypt(plaintext: string): Promise<string> {
    try {
      const { result } = await this.client.encrypt(this.cachingCMM, plaintext, {
        plaintextLength: plaintext.length,
      });

      return result.toString();
    } catch (e) {
      this.logger.error(
        `aws kms keyring 암호화 오류 plainText=${plaintext}, message=${e.message}`,
        e,
      );

      throw new Error(e.message);
    }
  }

  async decrypt(encryptedText: string): Promise<string> {
    try {
      const { plaintext } = await this.client.decrypt(
        this.cachingCMM,
        encryptedText,
      );

      return plaintext.toString();
    } catch (e) {
      this.logger.error(
        `aws kms keyring 복호화 오류 encryptedText=${encryptedText}, message=${e.message}`,
        e,
      );

      throw new Error(e.message);
    }
  }
}
