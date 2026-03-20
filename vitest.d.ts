import 'vitest';

declare module 'vitest' {
  interface CustomMatchers<R = unknown> {
    toBeBetween(min: number, max: number): R;

    toBeTrue(): R;

    toBeFalse(): R;

    toBeEmpty(): R;

    toMatchValidateErrorInlineSnapshot(
      property: string,
      snapshot?: string,
    ): R;
  }
}
