import { LogLevel } from '../platform/config/base.js';
import { loadMigrateSettings } from '../platform/config/settings.js';
import { createLogger } from '../platform/logger/logger.js';
import { runMigrations } from './run-migrations.js';

async function migrate(): Promise<void> {
  let log = createLogger({ logLevel: LogLevel.Info });
  try {
    const settings = loadMigrateSettings(process.env);
    log = createLogger(settings.base);
    const applied = await runMigrations({ databaseUrl: settings.database.url.reveal(), log });
    log.info({ applied: applied.length }, 'migrations complete');
  } catch (error) {
    log.error({ err: error }, 'migrations failed');
    process.exitCode = 1;
  }
}

await migrate();
