export class BuyerCreateResponse {
  id: number;

  get name(): string | undefined {
    return 'name';
  }

  get email(): string {
    return 'email';
  }
}
