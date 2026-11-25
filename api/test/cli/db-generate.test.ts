import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '../../src/platform/config/secret.js';
import { createPool } from '../../src/platform/db/create-pool.js';
import { createLogger } from '../../src/platform/logger/logger.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../support/postgres.js';
import { runMigrations } from '../../src/cli/run-migrations.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PGTYPED_CONFIG = join(PACKAGE_ROOT, 'pgtyped.config.json');
const PGTYPED_CLI = join(PACKAGE_ROOT, 'node_modules/@pgtyped/cli/lib/index.js');

const LARGEST_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

const LEDGER_MIGRATION = `
CREATE TABLE ledger_entries (id int PRIMARY KEY, amount_minor bigint NOT NULL);
INSERT INTO ledger_entries (id, amount_minor) VALUES (1, ${String(LARGEST_SAFE_MINOR)});
`;

const LEDGER_QUERY = `
/* @name ListLedgerEntries */
SELECT id, amount_minor FROM pos.ledger_entries WHERE id = :id!;
`;

let database: TestDatabase;
let workDir: string;

beforeAll(async () => {
  [database, workDir] = await Promise.all([
    startTestDatabase(),
    mkdtemp(join(tmpdir(), 'pos-pgtyped-')),
  ]);
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([database.stop(), rm(workDir, { recursive: true, force: true })]);
});

describe('db:generate against a migrated database', () => {
  it('types a bigint column as number, and the pool returns a number for it', async () => {
    const migrationsDir = join(workDir, 'migrations');
    const srcDir = join(workDir, 'src');
    const configPath = join(workDir, 'pgtyped.config.json');
    const config = JSON.parse(await readFile(PGTYPED_CONFIG, 'utf8')) as Record<string, unknown>;
    await Promise.all([mkdir(migrationsDir), mkdir(srcDir)]);
    await Promise.all([
      writeFile(join(migrationsDir, '0001_ledger.sql'), LEDGER_MIGRATION),
      writeFile(join(srcDir, 'ledger.sql'), LEDGER_QUERY),
      writeFile(configPath, JSON.stringify({ ...config, srcDir })),
    ]);
    await runMigrations({
      databaseUrl: database.migratorUrl,
      dir: migrationsDir,
      log: createLogger({ logLevel: 'warn' }, { write: () => undefined }),
    });

    await promisify(execFile)(process.execPath, [PGTYPED_CLI, '-c', configPath], {
      cwd: workDir,
      env: { DATABASE_URL: database.appUrl },
    });

    const generated = await readFile(join(srcDir, 'ledger.queries.ts'), 'utf8');
    expect(generated).toMatch(
      /export interface IListLedgerEntriesResult \{[^}]*amount_minor: number;/,
    );

    const pool = createPool({ url: new Secret(database.appUrl), maxConns: 1 });
    try {
      const result = await pool.query<{ amount_minor: unknown }>(
        'SELECT amount_minor FROM pos.ledger_entries WHERE id = 1',
      );
      expect(result.rows[0]?.amount_minor).toBe(LARGEST_SAFE_MINOR);
    } finally {
      await pool.end();
    }
  });
});
