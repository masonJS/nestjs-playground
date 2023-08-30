const isNil = <T>(value: T | null | undefined): value is null | undefined =>
  value === null || value === undefined;

export const throwIfIsNil =
  (error: Error) =>
  <T>(value: T | null | undefined): T => {
    if (isNil(value)) {
      throw error;
    }

    return value;
  };
