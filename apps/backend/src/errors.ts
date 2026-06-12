/** Application errors with HTTP status + stable machine-readable codes. */
export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Missing or invalid session token'): AppError =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const notFound = (what: string): AppError => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (msg: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', msg, details);
