export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const ensureError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const ignoreError = (): void => {};
