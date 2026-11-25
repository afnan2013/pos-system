import { DatabaseError } from 'pg';
import { causeChain } from '../errors/kind-of.js';

export type DatabaseErrorLog = {
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly dataType: string | undefined;
  readonly routine: string | undefined;
};

// No message key: pino would treat the object as an error and rewrite its type.
export type LoggedError = {
  readonly type: string;
  readonly stack?: string;
  readonly database: DatabaseErrorLog;
};

// Names and codes only: a database error's message, detail, where and hint can quote row values.
export function databaseErrorLog(err: unknown): DatabaseErrorLog | undefined {
  const databaseError = causeChain(err).find((link) => link instanceof DatabaseError);
  if (databaseError === undefined) return undefined;
  return {
    sqlState: databaseError.code,
    constraint: databaseError.constraint,
    schema: databaseError.schema,
    table: databaseError.table,
    column: databaseError.column,
    dataType: databaseError.dataType,
    routine: databaseError.routine,
  };
}

export function loggableError(err: unknown): unknown {
  const database = databaseErrorLog(err);
  if (database === undefined) return err;
  if (!(err instanceof Error) || err instanceof DatabaseError) {
    return { type: 'DatabaseError', database } satisfies LoggedError;
  }
  return {
    type: err.name,
    ...(err.stack === undefined ? {} : { stack: err.stack }),
    database,
  } satisfies LoggedError;
}
