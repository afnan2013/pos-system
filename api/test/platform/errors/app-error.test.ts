import { describe, expect, it } from 'vitest';
import {
  AppError,
  conflict,
  ErrCanceled,
  ErrConflict,
  ErrForbidden,
  ErrInvalidReference,
  ErrNotFound,
  ErrorKind,
  ErrRateLimited,
  ErrTooLarge,
  ErrUnauthorized,
  ErrUnavailable,
  unavailable,
  unexpected,
  validation,
} from '../../../src/platform/errors/app-error.js';
import { problemSpecs } from '../../../src/platform/errors/error-kind.js';

describe('AppError constructors', () => {
  it('builds a validation error with its fields', () => {
    const error = validation({ 'items[0].quantity': 'must be at least 1' });
    expect(error).toBeInstanceOf(AppError);
    expect(error.kind).toBe('validation');
    expect(error.title).toBe('Invalid input');
    expect(error.fields).toEqual({ 'items[0].quantity': 'must be at least 1' });
    expect('cause' in error).toBe(false);
  });

  it('uses a custom title when given and the default otherwise', () => {
    expect(conflict('Not enough stock').title).toBe('Not enough stock');
    expect(conflict().title).toBe('Conflict');
  });

  it('keeps the cause for the log', () => {
    const cause = new Error('connection terminated');
    expect(unavailable(undefined, cause).cause).toBe(cause);
    expect(unexpected(cause)).toMatchObject({ kind: 'unexpected', title: 'Internal Server Error' });
    expect(unexpected(cause).cause).toBe(cause);
  });

  it.each([
    [ErrUnauthorized, 'unauthorized'],
    [ErrForbidden, 'forbidden'],
    [ErrNotFound, 'not_found'],
    [ErrConflict, 'conflict'],
    [ErrInvalidReference, 'invalid_reference'],
    [ErrTooLarge, 'too_large'],
    [ErrRateLimited, 'rate_limited'],
    [ErrUnavailable, 'unavailable'],
    [ErrCanceled, 'canceled'],
  ])('shares %o with the default title', (error, kind) => {
    expect(error.kind).toBe(kind);
    expect(error.title).toBe(problemSpecs[error.kind].title);
  });
});

describe('problemSpecs', () => {
  it('maps every kind to its status and slug', () => {
    const table = Object.values(ErrorKind).map((kind) => [
      kind,
      problemSpecs[kind].status,
      problemSpecs[kind].slug,
      problemSpecs[kind].logAt,
    ]);
    expect(table).toEqual([
      ['validation', 400, 'validation', 'none'],
      ['unauthorized', 401, 'unauthorized', 'none'],
      ['forbidden', 403, 'forbidden', 'none'],
      ['not_found', 404, 'not-found', 'none'],
      ['conflict', 409, 'conflict', 'none'],
      ['invalid_reference', 400, 'invalid-reference', 'none'],
      ['too_large', 413, 'too-large', 'none'],
      ['rate_limited', 429, 'rate-limited', 'none'],
      ['unavailable', 503, 'unavailable', 'warn'],
      ['canceled', 499, 'canceled', 'info'],
      ['unexpected', 500, 'internal', 'error'],
    ]);
  });
});
