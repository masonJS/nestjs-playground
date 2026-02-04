export function expectNonNullable<T>(
  value?: T,
): asserts value is NonNullable<T> {
  expect(value).toBeTruthy();
}
