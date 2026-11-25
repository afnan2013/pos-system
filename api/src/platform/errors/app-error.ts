import { ErrorKind, problemSpecs } from './error-kind.js';

export { ErrorKind } from './error-kind.js';

export type FieldErrors = Readonly<Record<string, string>>;

export type AppErrorOptions = {
  fields?: FieldErrors;
  cause?: unknown;
};

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly title: string;
  readonly fields: FieldErrors | undefined;

  constructor(kind: ErrorKind, title: string, options: AppErrorOptions = {}) {
    super(title, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.kind = kind;
    this.title = title;
    this.fields = options.fields;
  }
}

export function validation(fields: FieldErrors, cause?: unknown): AppError {
  return new AppError(
    ErrorKind.Validation,
    problemSpecs.validation.title,
    withCause({ fields }, cause),
  );
}

export function unauthorized(title: string = problemSpecs.unauthorized.title): AppError {
  return new AppError(ErrorKind.Unauthorized, title);
}

export function forbidden(title: string = problemSpecs.forbidden.title): AppError {
  return new AppError(ErrorKind.Forbidden, title);
}

export function notFound(title: string = problemSpecs.not_found.title): AppError {
  return new AppError(ErrorKind.NotFound, title);
}

export function conflict(title: string = problemSpecs.conflict.title): AppError {
  return new AppError(ErrorKind.Conflict, title);
}

export function unavailable(
  title: string = problemSpecs.unavailable.title,
  cause?: unknown,
): AppError {
  return new AppError(ErrorKind.Unavailable, title, withCause({}, cause));
}

export function unexpected(cause: unknown): AppError {
  return new AppError(ErrorKind.Unexpected, problemSpecs.unexpected.title, { cause });
}

export const ErrUnauthorized = unauthorized();
export const ErrForbidden = forbidden();
export const ErrNotFound = notFound();
export const ErrConflict = conflict();
export const ErrInvalidReference = new AppError(
  ErrorKind.InvalidReference,
  problemSpecs.invalid_reference.title,
);
export const ErrTooLarge = new AppError(ErrorKind.TooLarge, problemSpecs.too_large.title);
export const ErrRateLimited = new AppError(ErrorKind.RateLimited, problemSpecs.rate_limited.title);
export const ErrUnavailable = unavailable();
export const ErrCanceled = new AppError(ErrorKind.Canceled, problemSpecs.canceled.title);

function withCause(options: AppErrorOptions, cause: unknown): AppErrorOptions {
  return cause === undefined ? options : { ...options, cause };
}
