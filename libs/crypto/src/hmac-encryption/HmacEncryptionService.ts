import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { DomainException } from '../../../web-common/src/res/exception/DomainException';

@Injectable()
export class HmacEncryptionService {
  private readonly SECRET;
  private readonly ALGORITHM = 'sha256';
  private readonly DIGEST = 'hex';
  private readonly SEPARATOR = '.';

  constructor(secret: string) {
    this.SECRET = secret;
  }

  encrypt(message: string): string {
    const nonce = this.createNonce();
    const hmac = this.createHmac(message, nonce);

    return this.encode(message, nonce, hmac);
  }

  decrypt(code: string): string {
    const [message, nonce, hmac] = this.decode(code);
    this.validateHmac(message, nonce, hmac);

    return message;
  }

  private createNonce() {
    return crypto.randomBytes(8).toString('hex');
  }

  private createHmac(message: string, nonce: string) {
    return crypto
      .createHmac(this.ALGORITHM, this.SECRET)
      .update(message + nonce)
      .digest(this.DIGEST);
  }

  private encode(message: string, nonce: string, hmac: string): string {
    return `${message}${this.SEPARATOR}${nonce}${this.SEPARATOR}${hmac}`;
  }

  private decode(data: string) {
    return data.split(this.SEPARATOR);
  }

  private validateHmac(message: string, nonce: string, hmac: string) {
    const expectedHmac = this.createHmac(message, nonce);

    if (hmac !== expectedHmac) {
      throw DomainException.BusinessError({
        message: 'Invalid HMAC.',
        parameter: { message, nonce, hmac },
      });
    }
  }
}
