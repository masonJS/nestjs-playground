import { PhoneNumber } from '../../../src/util/PhoneNumber';

describe('PhoneNumber', () => {
  describe('findKoreaPhoneNumber', () => {
    it.each([
      ['phone: 010-1234-5678', '010-1234-5678'],
      ['phone: 01012345678', '01012345678'],
      ['phone: 1012345678', '1012345678'],
    ])('문자열중 한국 번호를 조회한다.', (text, expectPhoneNumber) => {
      // given, when
      const result = PhoneNumber.findKoreaPhoneNumber(text);

      // then
      expect(result).toHaveLength(1);
      expect(result).toStrictEqual([expectPhoneNumber]);
    });
  });

  describe('formattingNumber', () => {
    it('앞 번호를 10을 010으로 변경한다.', () => {
      // given
      const phoneNumber = new PhoneNumber('1012345678');

      // when
      const result = phoneNumber.formattingNumber;

      // then
      expect(result).toBe('01012345678');
    });
  });

  describe('isValidPhoneNumber', () => {
    it.each(['1234-5678', '12345678', 'phoneXXX'])(
      '한국 번호가 아닌 경우 false를 반환한다.',
      (invalidNumber) => {
        // given
        const phoneNumber = new PhoneNumber(invalidNumber);

        // when
        const result = phoneNumber.isKoreaPhoneNumberFormat;

        // then
        expect(result).toBe(false);
      },
    );
  });
});
