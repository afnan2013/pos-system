import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { unexpected } from '../../../src/platform/errors/app-error.js';
import { databaseErrorLog, loggableError } from '../../../src/platform/db/loggable-error.js';
import { mapPgError } from '../../../src/platform/db/map-pg-error.js';

function notNullViolation(): DatabaseError {
  const error = new DatabaseError(
    'null value in column "name" of relation "menu_items" violates not-null constraint',
    0,
    'error',
  );
  Object.assign(error, {
    code: '23502',
    schema: 'pos',
    table: 'menu_items',
    column: 'name',
    routine: 'ExecConstraints',
    detail: 'Failing row contains (secret-row-value, null).',
    where: 'SQL statement "INSERT ..." with secret-where-value',
    hint: 'secret-hint-value',
  });
  return error;
}

describe('databaseErrorLog', () => {
  it('keeps only codes and names from the first database error in the chain', () => {
    expect(databaseErrorLog(mapPgError(notNullViolation()))).toEqual({
      sqlState: '23502',
      constraint: undefined,
      schema: 'pos',
      table: 'menu_items',
      column: 'name',
      dataType: undefined,
      routine: 'ExecConstraints',
    });
  });

  it('is undefined when no database error is in the chain', () => {
    expect(databaseErrorLog(unexpected(new Error('plain')))).toBeUndefined();
  });
});

describe('loggableError', () => {
  it('returns an error with no database error in its chain unchanged', () => {
    const error = unexpected(new Error('plain'));
    expect(loggableError(error)).toBe(error);
  });

  it('keeps the outer error stack and drops the database message, detail, where and hint', () => {
    const appError = mapPgError(notNullViolation());
    const logged = loggableError(appError);
    expect(logged).toMatchObject({
      type: 'AppError',
      stack: appError.stack,
      database: { sqlState: '23502', table: 'menu_items', column: 'name' },
    });
    const text = JSON.stringify(logged);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('null value in column');
  });

  it('logs a bare database error by its codes only', () => {
    expect(loggableError(notNullViolation())).toEqual({
      type: 'DatabaseError',
      database: expect.objectContaining({ sqlState: '23502' }) as unknown,
    });
  });
});
