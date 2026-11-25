import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../../support/postgres.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await database.stop();
});

async function asRole<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

describe('database roles from the init script', () => {
  it('lets migrator create tables in pos', async () => {
    await asRole(database.migratorUrl, async (client) => {
      await client.query('CREATE TABLE pos.role_probe (id int PRIMARY KEY)');
    });
  });

  it('gives pos_app data access to tables migrator creates', async () => {
    await asRole(database.migratorUrl, async (client) => {
      await client.query('CREATE TABLE pos.default_grant_probe (id int PRIMARY KEY)');
    });
    const rows = await asRole(database.appUrl, async (client) => {
      await client.query('INSERT INTO pos.default_grant_probe (id) VALUES (1)');
      await client.query('UPDATE pos.default_grant_probe SET id = 2');
      const result = await client.query<{ id: number }>('SELECT id FROM pos.default_grant_probe');
      await client.query('DELETE FROM pos.default_grant_probe');
      return result.rows;
    });
    expect(rows).toEqual([{ id: 2 }]);
  });

  it('refuses CREATE TABLE in pos to pos_app', async () => {
    await expect(
      asRole(database.appUrl, (client) => client.query('CREATE TABLE pos.app_probe (id int)')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses CREATE TABLE in public to pos_app', async () => {
    await expect(
      asRole(database.appUrl, (client) => client.query('CREATE TABLE public.app_probe (id int)')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses CREATE SCHEMA to pos_app', async () => {
    await expect(
      asRole(database.appUrl, (client) => client.query('CREATE SCHEMA app_probe')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('sets the session timeouts on pos_app', async () => {
    const settings = await asRole(database.appUrl, async (client) => {
      const statement = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      const lock = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
      const idle = await client.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      );
      return {
        statement: statement.rows[0]?.statement_timeout,
        lock: lock.rows[0]?.lock_timeout,
        idle: idle.rows[0]?.idle_in_transaction_session_timeout,
      };
    });
    expect(settings).toEqual({ statement: '5s', lock: '2s', idle: '10s' });
  });

  it('runs the image the helper pins', async () => {
    const version = await asRole(database.appUrl, async (client) => {
      const result = await client.query<{ server_version: string }>('SHOW server_version');
      return result.rows[0]?.server_version;
    });
    expect(version).toBe('18.7');
  });
});
