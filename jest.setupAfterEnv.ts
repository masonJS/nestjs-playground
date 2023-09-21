import { ValidationError } from 'class-validator';
import { toMatchInlineSnapshot } from 'jest-snapshot';

function toBeBetween(actual: number, min: number, max: number) {
  const pass = actual >= min && actual <= max;

  return {
    pass,
    message: pass
      ? () => `expected ${actual} not to be within range (${min}..${max})`
      : () => `expected ${actual} to be within range (${min}..${max})`,
  };
}

function toBeTrue(actual: boolean) {
  const pass = actual === true;

  return {
    pass,
    message: pass
      ? () => `expected ${actual} not to be true`
      : () => `expected ${actual} to be true`,
  };
}

function toBeFalse(actual: boolean) {
  const pass = actual === false;

  return {
    pass,
    message: pass
      ? () => `expected ${actual} not to be false`
      : () => `expected ${actual} to be false`,
  };
}

function toBeEmpty(actual: any[]) {
  const pass = actual.length === 0;

  return {
    pass,
    message: pass
      ? () => `expected ${JSON.stringify(actual)} not to be empty`
      : () => `expected ${JSON.stringify(actual)} to be empty`,
  };
}

expect.extend({
  toBeBetween,
  toBeTrue,
  toBeFalse,
  toBeEmpty,
  async toMatchValidateErrorInlineSnapshot(
    actual: ValidationError[],
    property: string,
    ...rest
  ) {
    const validateErrors = actual.filter(
      (error) => error.property === property,
    );

    return await toMatchInlineSnapshot.call(
      this as any,
      validateErrors[0].constraints,
      ...rest,
    );
  },
});
