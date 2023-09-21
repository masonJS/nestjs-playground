declare global {
  namespace jest {
    interface Matchers<R> {
      toBeBetween(min: number, max: number): R;

      toBeTrue(): R;

      toBeFalse(): R;

      toBeEmpty(): R;

      toMatchValidateErrorInlineSnapshot(property: string, snapshot: string): R;
    }
  }
}

export {};
