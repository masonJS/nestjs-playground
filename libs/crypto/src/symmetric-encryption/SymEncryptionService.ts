import { createCipheriv, createDecipheriv } from 'node:crypto';
import { scryptSync } from 'crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SymEncryptionService {
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private readonly algorithm = 'aes-256-cbc';
  private readonly inputEncoding = 'utf8';
  private readonly outputEncoding = 'hex';
  private readonly salt = 'salt';

  constructor(private readonly symmetricKey: string) {
    this.key = this.getBytes(this.symmetricKey, 32);
    this.iv = this.getBytes(this.symmetricKey, 16);
  }

  encrypt(originalText: string): string {
    const cipher = createCipheriv(this.algorithm, this.key, this.iv);

    return (
      cipher.update(originalText, this.inputEncoding, this.outputEncoding) +
      cipher.final(this.outputEncoding)
    );
  }

  decrypt(encryptedText: string): string {
    const decipher = createDecipheriv(this.algorithm, this.key, this.iv);

    return (
      decipher.update(encryptedText, this.outputEncoding, this.inputEncoding) +
      decipher.final(this.inputEncoding)
    );
  }

  private getBytes(strKey: string, size: number) {
    return scryptSync(strKey, this.salt, size) as Buffer;
  }
}
