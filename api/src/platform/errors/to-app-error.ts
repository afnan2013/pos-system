import { hasProperty } from '../has-property.js';
import { AppError, unexpected, validation } from './app-error.js';
import { ErrorKind, problemSpecs } from './error-kind.js';

// The parser's own message can quote the body, which may hold a password.
export const INVALID_BODY_FIELDS = {
  body: 'must be one JSON object with only the documented fields',
} as const;

const INVALID_BODY_TYPES: ReadonlySet<string> = new Set([
  'entity.parse.failed',
  'encoding.unsupported',
  'charset.unsupported',
  'request.size.invalid',
]);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const parserType = bodyParserType(err);
  if (parserType === 'entity.too.large') {
    return new AppError(ErrorKind.TooLarge, problemSpecs.too_large.title, { cause: err });
  }
  if (parserType !== undefined && INVALID_BODY_TYPES.has(parserType)) {
    return validation(INVALID_BODY_FIELDS, err);
  }
  if (parserType === 'request.aborted') {
    return new AppError(ErrorKind.Canceled, problemSpecs.canceled.title, { cause: err });
  }
  return unexpected(err);
}

function bodyParserType(err: unknown): string | undefined {
  return err instanceof Error && hasProperty(err, 'type') && typeof err.type === 'string'
    ? err.type
    : undefined;
}
