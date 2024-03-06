import { HmacEncryptionService } from '@app/crypto/hmac-encryption/HmacEncryptionService';

describe('HmacEncryptionService', () => {
  let service: HmacEncryptionService;
  const secret = 'test-secret';

  beforeAll(() => {
    service = new HmacEncryptionService(secret);
  });

  it('hmac 으로 암호화 메시지를 복호화한다.', () => {
    const message = 'test-message';
    const encrypted = service.encrypt(message);

    expect(service.decrypt(encrypted)).toBe(message);
  });

  it('hmac 으로 암호화한 메시지가 아닌 경우 에러를 발생한다.', () => {
    // given
    const message = 'test-message';
    const encrypted = service.encrypt(message);

    // when then
    expect(() => service.decrypt(encrypted + 'a')).toThrowError('Invalid HMAC');
  });
});
