/// Errors thrown by services and translated into a JSON response by
/// `installErrorHandling`, which both APIs share. Anything else is a bug and
/// becomes a 500 without leaking its message to the client.
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Forbidden'): AppError =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found'): AppError =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, details);

export const tooManyRequests = (message: string): AppError =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);
