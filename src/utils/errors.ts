const getErrorCause = (error: Error): unknown =>
  'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined;

const collectErrorMessages = (error: unknown, seen: Set<Error>): string[] => {
  if (!(error instanceof Error)) {
    return [String(error)];
  }

  if (seen.has(error)) {
    return [error.message || error.name];
  }

  seen.add(error);
  const baseMessage = error.message || error.name;
  const cause = getErrorCause(error);
  if (cause === undefined) {
    return [baseMessage];
  }

  return [baseMessage, ...collectErrorMessages(cause, seen)];
};

export const toErrorMessage = (error: unknown): string => {
  const [head = 'Unknown error', ...causes] = collectErrorMessages(error, new Set<Error>());
  if (causes.length === 0) {
    return head;
  }
  return `${head}\n${causes.map((cause) => `Caused by: ${cause}`).join('\n')}`;
};

export const ensureError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const isErrnoException = (
  error: unknown
): error is NodeJS.ErrnoException & { code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as NodeJS.ErrnoException).code === 'string';

export const ignoreError = (): void => {};
