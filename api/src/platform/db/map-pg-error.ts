import { AppError, ErrorKind, unavailable, unexpected } from '../errors/app-error.js';
import { problemSpecs } from '../errors/error-kind.js';
import { hasProperty } from '../has-property.js';

const UNAVAILABLE_SQLSTATES = new Set([
  '40001',
  '40P01',
  '57014',
  '55P03',
  '25P03',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

const CONNECTION_ERROR_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
];

function errorCode(err: unknown): string | undefined {
  return hasProperty(err, 'code') && typeof err.code === 'string' ? err.code : undefined;
}

function isConnectionError(err: unknown, code: string | undefined): boolean {
  if (code !== undefined && (code.startsWith('08') || NETWORK_ERROR_CODES.has(code))) return true;
  if (!(err instanceof Error)) return false;
  return CONNECTION_ERROR_MESSAGES.some((message) => err.message.startsWith(message));
}

export function mapPgError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const code = errorCode(err);
  switch (code) {
    case '23505':
    case '23001':
      return new AppError(ErrorKind.Conflict, problemSpecs.conflict.title, { cause: err });
    case '23503':
      return new AppError(ErrorKind.InvalidReference, problemSpecs.invalid_reference.title, {
        cause: err,
      });
    case '23514':
      return new AppError(ErrorKind.Validation, problemSpecs.validation.title, { cause: err });
  }
  if ((code !== undefined && UNAVAILABLE_SQLSTATES.has(code)) || isConnectionError(err, code)) {
    return unavailable(undefined, err);
  }
  return unexpected(err);
}
