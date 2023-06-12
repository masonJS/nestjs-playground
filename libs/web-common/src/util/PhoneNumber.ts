import { findPhoneNumbersInText, isValidPhoneNumber } from 'libphonenumber-js';

export class PhoneNumber {
  private readonly _phoneNumber: string;

  constructor(phoneNumber: string) {
    this._phoneNumber = phoneNumber;
  }

  static findKoreaPhoneNumber(text: string): string[] {
    return findPhoneNumbersInText(text, 'KR').map((findNumber) =>
      text.substring(findNumber.startsAt, findNumber.endsAt),
    );
  }

  get phoneNumber(): string {
    return this._phoneNumber;
  }

  get formattingNumber() {
    if ([10, 11].includes(this.phoneNumber.length)) {
      return this.phoneNumber.substring(0, 2) === '10'
        ? '0' + this.phoneNumber
        : this.phoneNumber;
    }

    return '';
  }

  get isKoreaPhoneNumberFormat() {
    const formattedNumber = this.formattingNumber;

    return isValidPhoneNumber(formattedNumber, 'KR');
  }
}
