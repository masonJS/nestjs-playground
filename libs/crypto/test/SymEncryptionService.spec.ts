import { Configuration } from '@app/config/Configuration';
import { SymEncryptionService } from '@app/crypto/symmetric-encryption/SymEncryptionService';

describe('SymEncryptionService', () => {
  const cryptoEnv = Configuration.getEnv().crypto;
  const service = new SymEncryptionService(cryptoEnv.symmetricKey);

  it('encrypt and decrypt', () => {
    // given
    const originalText = 'hello world';
    const encryptedText = service.encrypt(originalText);

    // when
    const decryptedText = service.decrypt(encryptedText);

    // then
    expect(decryptedText).toBe(originalText);
  });
});
