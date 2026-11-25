import pg, { type Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Secret } from '../../../src/platform/config/secret.js';
import { AppError, ErrorKind } from '../../../src/platform/errors/app-error.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../../support/postgres.js';
import { createPool } from '../../../src/platform/db/create-pool.js';
import { withTx } from '../../../src/platform/db/with-tx.js';

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  const migrator = new pg.Client({ connectionString: database.migratorUrl });
  await migrator.connect();
  await migrator.query('CREATE TABLE pos.tx_probe (id int PRIMARY KEY, note text NOT NULL)');
  await migrator.end();
  pool = createPool({ url: new Secret(database.appUrl), maxConns: 3 });
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await pool.end();
  await database.stop();
});

beforeEach(async () => {
  await pool.query('DELETE FROM pos.tx_probe');
});

afterEach(() => {
  expect(pool.idleCount).toBe(pool.totalCount);
});

async function probeIds(): Promise<number[]> {
  const result = await pool.query<{ id: number }>('SELECT id FROM pos.tx_probe ORDER BY id');
  return result.rows.map((row) => row.id);
}

describe('withTx', () => {
  it('commits when the callback resolves and returns its result', async () => {
    const result = await withTx(pool, async (tx) => {
      await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'a'), (2, 'b')");
      return 'done';
    });
    expect(result).toBe('done');
    expect(await probeIds()).toEqual([1, 2]);
  });

  it('runs every statement on one connection inside one transaction', async () => {
    const seen = await withTx(pool, async (tx) => {
      const first = await tx.query<{ pid: number; xid: string }>(
        'SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid',
      );
      const second = await tx.query<{ pid: number; xid: string }>(
        'SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid',
      );
      return [first.rows[0], second.rows[0]];
    });
    expect(seen[0]).toEqual(seen[1]);
  });

  it('rolls back and rethrows an AppError unchanged', async () => {
    const thrown = new AppError(ErrorKind.Conflict, 'Not enough stock');
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'a')");
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(await probeIds()).toEqual([]);
  });

  it('rolls back and maps a database error', async () => {
    const failure = withTx(pool, async (tx) => {
      await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'a')");
      await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'again')");
    });
    await expect(failure).rejects.toMatchObject({
      kind: ErrorKind.Conflict,
      cause: { code: '23505' },
    });
    expect(await probeIds()).toEqual([]);
  });

  it('rolls back and wraps any other error as unexpected', async () => {
    const thrown = new TypeError('bug');
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'a')");
        throw thrown;
      }),
    ).rejects.toMatchObject({ kind: ErrorKind.Unexpected, cause: thrown });
    expect(await probeIds()).toEqual([]);
  });

  it('discards a connection that died mid-transaction and keeps the pool usable', async () => {
    let deadPid: number | undefined;
    await expect(
      withTx(pool, async (tx) => {
        await tx.query("INSERT INTO pos.tx_probe (id, note) VALUES (1, 'a')");
        const result = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        deadPid = result.rows[0]?.pid;
        await tx.query('SELECT pg_terminate_backend(pg_backend_pid())');
      }),
    ).rejects.toMatchObject({ kind: ErrorKind.Unavailable });
    const nextPid = await withTx(pool, async (tx) => {
      const result = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return result.rows[0]?.pid;
    });
    expect(deadPid).toBeTypeOf('number');
    expect(nextPid).not.toBe(deadPid);
    expect(await probeIds()).toEqual([]);
  });

  it('maps a failure to check out a connection', async () => {
    const unreachable = createPool({
      url: new Secret('postgres://pos_app:unused@127.0.0.1:1/pos'),
      maxConns: 1,
    });
    try {
      await expect(withTx(unreachable, () => Promise.resolve())).rejects.toMatchObject({
        kind: ErrorKind.Unavailable,
      });
    } finally {
      await unreachable.end();
    }
  });
});

describe('withTx rollback bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting for ROLLBACK after 5 seconds and releases the connection as broken', async () => {
    vi.useFakeTimers();
    const release = vi.fn<(err?: Error | boolean) => void>();
    const client = {
      query: (sql: string) =>
        sql === 'ROLLBACK' ? new Promise(() => undefined) : Promise.resolve(),
      on: () => client,
      off: () => client,
      release,
    };
    const fakePool = { connect: () => Promise.resolve(client as unknown as PoolClient) };
    const thrown = new AppError(ErrorKind.Conflict, 'Not enough stock');

    const outcome = withTx(fakePool as unknown as Pool, () => Promise.reject(thrown));
    const settled = expect(outcome).rejects.toBe(thrown);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
