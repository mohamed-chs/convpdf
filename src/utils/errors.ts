export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const ensureError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const isErrnoException = (
  error: unknown
): error is NodeJS.ErrnoException & { code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as NodeJS.ErrnoException).code === 'string';

export const ignoreError = (): void => {};
