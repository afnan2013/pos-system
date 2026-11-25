import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Logger } from '../platform/logger/logger.js';

// Two levels up from both src/cli and dist/cli, so tsx and the built image find the same folder.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export const MIGRATIONS_SCHEMA = 'pos_meta';
export const MIGRATIONS_TABLE = 'pos_migrations';

export type RunMigrationsOptions = {
  readonly databaseUrl: string;
  readonly log: Logger;
  readonly dir?: string;
};

export class MigrationError extends Error {
  readonly migration: string | undefined;

  constructor(migration: string | undefined, cause: unknown) {
    super(
      migration === undefined
        ? 'migrations could not start'
        : `migration ${migration} failed and was rolled back unless it runs without a transaction`,
      { cause },
    );
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<readonly string[]> {
  const progress = trackProgress(options.log);
  try {
    await runner({
      databaseUrl: options.databaseUrl,
      dir: options.dir ?? MIGRATIONS_DIR,
      schema: 'pos',
      migrationsSchema: MIGRATIONS_SCHEMA,
      createMigrationsSchema: true,
      migrationsTable: MIGRATIONS_TABLE,
      direction: 'up',
      singleTransaction: false,
      checkOrder: true,
      logger: progress.logger,
    });
  } catch (error) {
    throw new MigrationError(progress.started(), error);
  }
  progress.finish();
  return progress.applied;
}

const MIGRATION_START = /^### MIGRATION (.+) \(UP\) ###$/;

// The runner announces a file before running it, so a file is applied once the next starts or the run ends.
function trackProgress(log: Logger) {
  const applied: string[] = [];
  let current: string | undefined;

  const settle = () => {
    if (current === undefined) return;
    applied.push(current);
    log.info({ migration: current }, 'migration applied');
    current = undefined;
  };

  return {
    applied,
    started: () => current,
    finish: settle,
    logger: {
      info: (message: string) => {
        const start = MIGRATION_START.exec(message);
        if (start?.[1] === undefined) {
          log.debug(message);
          return;
        }
        settle();
        current = start[1];
      },
      warn: (message: string) => {
        log.warn(message);
      },
      // The CLI logs the failure once, with its cause; the runner's own copy is detail.
      error: (message: string) => {
        log.debug(message);
      },
    },
  };
}
