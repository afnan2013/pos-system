import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '../../../src/platform/config/secret.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../../support/postgres.js';
import { createPool } from '../../../src/platform/db/create-pool.js';

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = createPool({ url: new Secret(database.appUrl), maxConns: 2 });
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await pool.end();
  await database.stop();
});

describe('createPool', () => {
  it('connects as pos_app with the pos-api application name', async () => {
    const result = await pool.query<{ user: string; app: string }>(
      "SELECT current_user AS user, current_setting('application_name') AS app",
    );
    expect(result.rows).toEqual([{ user: 'pos_app', app: 'pos-api' }]);
  });

  it('returns int8 values as numbers', async () => {
    const result = await pool.query<{ small: number; largest: number; total: number }>(
      `SELECT 42::int8 AS small, ${String(Number.MAX_SAFE_INTEGER)}::int8 AS largest,
              SUM(n)::bigint AS total FROM (VALUES (1::int8), (2::int8)) AS t(n)`,
    );
    expect(result.rows).toEqual([{ small: 42, largest: Number.MAX_SAFE_INTEGER, total: 3 }]);
  });

  it('keeps a null int8 as null', async () => {
    const result = await pool.query<{ value: number | null }>('SELECT NULL::int8 AS value');
    expect(result.rows).toEqual([{ value: null }]);
  });

  it('refuses an int8 beyond the safe integer range and keeps the connection usable', async () => {
    const client = await pool.connect();
    try {
      await expect(client.query('SELECT 9007199254740992::int8 AS value')).rejects.toThrow(
        RangeError,
      );
      const after = await client.query<{ value: number }>('SELECT 7::int8 AS value');
      expect(after.rows).toEqual([{ value: 7 }]);
    } finally {
      client.release();
    }
  });

  it('opens no more connections than maxConns', async () => {
    const [first, second] = await Promise.all([pool.connect(), pool.connect()]);
    expect(pool.totalCount).toBe(2);
    const third = pool.connect();
    expect(pool.waitingCount).toBe(1);
    first.release();
    const reused = await third;
    reused.release();
    second.release();
  });
});
