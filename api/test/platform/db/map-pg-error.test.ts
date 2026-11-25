import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '../../../src/platform/config/secret.js';
import { AppError, ErrorKind } from '../../../src/platform/errors/app-error.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../../support/postgres.js';
import { createPool } from '../../../src/platform/db/create-pool.js';
import { mapPgError } from '../../../src/platform/db/map-pg-error.js';
import { withTx } from '../../../src/platform/db/with-tx.js';

function withCode(code: string, message = 'database error'): Error {
  return Object.assign(new Error(message), { code });
}

describe('mapPgError', () => {
  it.each([
    ['23505', ErrorKind.Conflict],
    ['23001', ErrorKind.Conflict],
    ['23503', ErrorKind.InvalidReference],
    ['23514', ErrorKind.Validation],
    ['40001', ErrorKind.Unavailable],
    ['40P01', ErrorKind.Unavailable],
    ['57014', ErrorKind.Unavailable],
    ['55P03', ErrorKind.Unavailable],
    ['25P03', ErrorKind.Unavailable],
    ['53300', ErrorKind.Unavailable],
    ['57P01', ErrorKind.Unavailable],
    ['08006', ErrorKind.Unavailable],
    ['ECONNREFUSED', ErrorKind.Unavailable],
    ['ECONNRESET', ErrorKind.Unavailable],
    ['ETIMEDOUT', ErrorKind.Unavailable],
    ['EPIPE', ErrorKind.Unavailable],
    ['ENOTFOUND', ErrorKind.Unavailable],
    ['42501', ErrorKind.Unexpected],
    ['23502', ErrorKind.Unexpected],
    ['22P02', ErrorKind.Unexpected],
  ])('maps code %s to %s and keeps the original as cause', (code, kind) => {
    const original = withCode(code);
    const mapped = mapPgError(original);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.kind).toBe(kind);
    expect(mapped.cause).toBe(original);
  });

  it.each([
    'Connection terminated',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])('maps the connection error "%s" to unavailable', (message) => {
    expect(mapPgError(new Error(message)).kind).toBe(ErrorKind.Unavailable);
  });

  it('gives a check violation the generic title and no field errors', () => {
    const mapped = mapPgError(
      Object.assign(withCode('23514'), { constraint: 'outlet_inventory_quantity_check' }),
    );
    expect(mapped.title).toBe('Invalid input');
    expect(mapped.fields).toBeUndefined();
  });

  it('returns an AppError unchanged', () => {
    const appError = new AppError(ErrorKind.NotFound, 'Not found');
    expect(mapPgError(appError)).toBe(appError);
  });

  it('wraps anything else as unexpected', () => {
    const original = new Error('something else');
    const mapped = mapPgError(original);
    expect(mapped.kind).toBe(ErrorKind.Unexpected);
    expect(mapped.cause).toBe(original);
    expect(mapPgError('not an error').kind).toBe(ErrorKind.Unexpected);
  });
});

describe('mapPgError against Postgres', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    const migrator = new pg.Client({ connectionString: database.migratorUrl });
    await migrator.connect();
    await migrator.query(`
      CREATE TABLE pos.map_parents (id int PRIMARY KEY);
      CREATE TABLE pos.map_children (
        id int PRIMARY KEY,
        parent_id int NOT NULL REFERENCES pos.map_parents (id) ON DELETE RESTRICT
      );
      CREATE TABLE pos.map_stock (
        sku text NOT NULL UNIQUE,
        quantity int NOT NULL CHECK (quantity >= 0)
      );
      INSERT INTO pos.map_parents (id) VALUES (1);
      INSERT INTO pos.map_children (id, parent_id) VALUES (1, 1);
      INSERT INTO pos.map_stock (sku, quantity) VALUES ('latte', 1);
    `);
    await migrator.end();
    pool = createPool({ url: new Secret(database.appUrl), maxConns: 4 });
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  async function failure(sql: string): Promise<unknown> {
    try {
      await pool.query(sql);
    } catch (err) {
      return err;
    }
    throw new Error(`expected the statement to fail: ${sql}`);
  }

  it.each([
    [
      'unique violation',
      "INSERT INTO pos.map_stock (sku, quantity) VALUES ('latte', 1)",
      '23505',
      ErrorKind.Conflict,
    ],
    [
      'foreign key violation',
      'INSERT INTO pos.map_children (id, parent_id) VALUES (2, 99)',
      '23503',
      ErrorKind.InvalidReference,
    ],
    ['restrict violation', 'DELETE FROM pos.map_parents WHERE id = 1', '23001', ErrorKind.Conflict],
    [
      'check violation',
      "UPDATE pos.map_stock SET quantity = -1 WHERE sku = 'latte'",
      '23514',
      ErrorKind.Validation,
    ],
    [
      'insufficient privilege',
      'CREATE TABLE pos.map_denied (id int)',
      '42501',
      ErrorKind.Unexpected,
    ],
    [
      'not-null violation',
      'INSERT INTO pos.map_parents (id) VALUES (NULL)',
      '23502',
      ErrorKind.Unexpected,
    ],
    ['invalid input syntax', "SELECT 'abc'::int", '22P02', ErrorKind.Unexpected],
  ])('maps a real %s', async (_name, sql, code, kind) => {
    const original = await failure(sql);
    expect(original).toMatchObject({ code });
    expect(mapPgError(original).kind).toBe(kind);
  });

  it.each(['40001', '40P01', '25P03', '53300'])(
    'maps a raised SQLSTATE %s to unavailable',
    async (code) => {
      const original = await failure(
        `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '${code}'; END $$`,
      );
      expect(original).toMatchObject({ code });
      expect(mapPgError(original).kind).toBe(ErrorKind.Unavailable);
    },
  );

  it('maps a statement timeout to unavailable', async () => {
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '50ms'");
        await tx.query('SELECT pg_sleep(2)');
      }),
    ).rejects.toMatchObject({ kind: ErrorKind.Unavailable, cause: { code: '57014' } });
  });

  it('maps a lock that is not available to unavailable', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT sku FROM pos.map_stock WHERE sku = 'latte' FOR UPDATE");
      await expect(
        withTx(pool, async (tx) => {
          await tx.query("SELECT sku FROM pos.map_stock WHERE sku = 'latte' FOR UPDATE NOWAIT");
        }),
      ).rejects.toMatchObject({ kind: ErrorKind.Unavailable, cause: { code: '55P03' } });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('maps a refused connection to unavailable', async () => {
    const unreachable = createPool({
      url: new Secret('postgres://pos_app:unused@127.0.0.1:1/pos'),
      maxConns: 1,
    });
    try {
      const original = await unreachable.query('SELECT 1').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(original).toMatchObject({ code: 'ECONNREFUSED' });
      expect(mapPgError(original).kind).toBe(ErrorKind.Unavailable);
    } finally {
      await unreachable.end();
    }
  });
});
