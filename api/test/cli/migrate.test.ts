import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/platform/logger/logger.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../support/postgres.js';
import { MigrationError, runMigrations } from '../../src/cli/run-migrations.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATE_ENTRY = fileURLToPath(new URL('../../src/cli/migrate.ts', import.meta.url));

const WIDGETS_SQL = `
CREATE TABLE widgets (id int PRIMARY KEY, name text NOT NULL);
REVOKE ALL ON widgets FROM pos_app;
GRANT SELECT ON widgets TO pos_app;
`;

const CONCURRENT_INDEX_TS = `
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.noTransaction();
  pgm.sql('CREATE INDEX CONCURRENTLY ix_widgets_name ON pos.widgets (name)');
}
`;

const PARTS_SQL = 'CREATE TABLE parts (id int PRIMARY KEY);';

const FAILING_SQL = `
CREATE TABLE pos.gadgets (id int PRIMARY KEY);
SELECT 1 / 0;
`;

let database: TestDatabase;
let migrationsDir: string;

beforeAll(async () => {
  [database, migrationsDir] = await Promise.all([
    startTestDatabase(),
    mkdtemp(join(tmpdir(), 'pos-migrations-')),
  ]);
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([database.stop(), rm(migrationsDir, { recursive: true, force: true })]);
});

function capturingLogger() {
  const lines: string[] = [];
  const log = createLogger({ logLevel: 'info' }, { write: (line) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, records };
}

async function asRole<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function recordedMigrations(): Promise<string[]> {
  return asRole(database.migratorUrl, async (client) => {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM pos_meta.pos_migrations ORDER BY id',
    );
    return result.rows.map((row) => row.name);
  });
}

function tableExists(name: string): Promise<boolean> {
  return asRole(database.migratorUrl, async (client) => {
    const result = await client.query<{ found: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS found',
      [`pos.${name}`],
    );
    return result.rows[0]?.found ?? false;
  });
}

async function resetMigrations(): Promise<void> {
  await asRole(database.migratorUrl, (client) =>
    client.query(
      'DROP SCHEMA pos_meta CASCADE; DROP TABLE IF EXISTS pos.widgets, pos.parts, pos.gadgets',
    ),
  );
  await Promise.all(
    ['0003_c.sql', '0004_d.sql'].map((file) => rm(join(migrationsDir, file), { force: true })),
  );
}

async function writeFirstTwoMigrations(): Promise<void> {
  await Promise.all([
    writeFile(join(migrationsDir, '0001_a.sql'), WIDGETS_SQL),
    writeFile(join(migrationsDir, '0002_b.ts'), CONCURRENT_INDEX_TS),
  ]);
}

describe('runMigrations', () => {
  it('applies a SQL file and a no-transaction TypeScript file in order and logs each one', async () => {
    await writeFirstTwoMigrations();
    const { log, records } = capturingLogger();

    const applied = await runMigrations({
      databaseUrl: database.migratorUrl,
      dir: migrationsDir,
      log,
    });

    expect(applied).toEqual(['0001_a', '0002_b']);
    expect(await recordedMigrations()).toEqual(['0001_a', '0002_b']);
    const appliedLines = records().filter((record) => record['msg'] === 'migration applied');
    expect(appliedLines.map((record) => record['migration'])).toEqual(['0001_a', '0002_b']);
    const index = await asRole(database.migratorUrl, async (client) => {
      const result = await client.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid FROM pg_index i
          WHERE i.indexrelid = 'pos.ix_widgets_name'::regclass`,
      );
      return result.rows[0];
    });
    expect(index).toEqual({ valid: true });
  });

  it('does nothing on a second run', async () => {
    const { log, records } = capturingLogger();

    const applied = await runMigrations({
      databaseUrl: database.migratorUrl,
      dir: migrationsDir,
      log,
    });

    expect(applied).toEqual([]);
    expect(await recordedMigrations()).toEqual(['0001_a', '0002_b']);
    expect(records().filter((record) => record['msg'] === 'migration applied')).toEqual([]);
  });

  it('refuses a new file numbered before one already applied', async () => {
    const early = join(migrationsDir, '0000_early.sql');
    await writeFile(early, 'SELECT 1;');
    try {
      const { log } = capturingLogger();
      await expect(
        runMigrations({ databaseUrl: database.migratorUrl, dir: migrationsDir, log }),
      ).rejects.toMatchObject({ name: 'MigrationError', migration: undefined });
    } finally {
      await rm(early);
    }
  });

  it('keeps the files before a failing one applied and rolls back the failing file', async () => {
    await resetMigrations();
    await Promise.all([
      writeFile(join(migrationsDir, '0003_c.sql'), PARTS_SQL),
      writeFile(join(migrationsDir, '0004_d.sql'), FAILING_SQL),
    ]);
    const { log, records } = capturingLogger();

    const failure = await runMigrations({
      databaseUrl: database.migratorUrl,
      dir: migrationsDir,
      log,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({ migration: '0004_d', cause: { code: '22012' } });
    expect(await recordedMigrations()).toEqual(['0001_a', '0002_b', '0003_c']);
    expect(await tableExists('parts')).toBe(true);
    expect(await tableExists('gadgets')).toBe(false);
    const appliedLines = records().filter((record) => record['msg'] === 'migration applied');
    expect(appliedLines.map((record) => record['migration'])).toEqual([
      '0001_a',
      '0002_b',
      '0003_c',
    ]);
    expect(records().filter((record) => record['level'] === 'error')).toEqual([]);
  });

  it('keeps the migration log out of reach of pos_app', async () => {
    await expect(
      asRole(database.appUrl, (client) => client.query('SELECT name FROM pos_meta.pos_migrations')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole(database.appUrl, (client) => client.query('SELECT id FROM pos.widgets')),
    ).resolves.toBeDefined();
  });
});

describe('the migrate CLI', () => {
  const execFileAsync = promisify(execFile);

  async function runCli(env: Record<string, string>): Promise<{ code: number; stdout: string }> {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', MIGRATE_ENTRY], {
        cwd: PACKAGE_ROOT,
        env,
      });
      return { code: 0, stdout };
    } catch (error) {
      const { code, stdout } = error as { code: number; stdout: string };
      return { code, stdout };
    }
  }

  function jsonLines(stdout: string): Record<string, unknown>[] {
    return stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('applies the package migrations folder and writes only JSON log lines', async () => {
    await resetMigrations();

    const { code, stdout } = await runCli({
      APP_ENV: 'local',
      MIGRATOR_DATABASE_URL: database.migratorUrl,
    });

    expect(code).toBe(0);
    expect(jsonLines(stdout).map((record) => record['msg'])).toContain('migrations complete');
  });

  it('exits non-zero and names the missing setting without connecting', async () => {
    const { code, stdout } = await runCli({ APP_ENV: 'local' });

    expect(code).toBe(1);
    const failure = jsonLines(stdout).find((record) => record['msg'] === 'migrations failed');
    expect(JSON.stringify(failure)).toContain('MIGRATOR_DATABASE_URL');
  });
});
