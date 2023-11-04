export class Phone {
  countryNumber: string;
  phoneNumber: string;

  constructor(countryNumber: string, phoneNumber: string) {
    this.countryNumber = countryNumber;
    this.phoneNumber = phoneNumber;
  }

  static create(countryNumber: string, phoneNumber: string): Phone {
    return new Phone(countryNumber, phoneNumber);
  }
}
