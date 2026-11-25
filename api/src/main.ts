import { buildApp } from './app.js';
import { loadSettings } from './platform/config/settings.js';
import { createPool } from './platform/db/create-pool.js';
import { createLogger } from './platform/logger/logger.js';
import { logger, setRootLogger } from './platform/logger/request-context.js';
import { installProcessHandlers, serveUntilStopped } from './platform/process.js';
import { buildServices } from './services.js';

async function main(): Promise<void> {
  const settings = loadSettings(process.env);
  const rootLogger = createLogger(settings.base);
  setRootLogger(rootLogger);
  installProcessHandlers(rootLogger);
  rootLogger.info({ settings }, 'config loaded');
  const pool = createPool(settings.database);
  const services = buildServices(pool);
  const app = buildApp(services);
  await serveUntilStopped(app, settings.http, pool);
}

main().catch((err: unknown) => {
  logger().fatal({ err }, 'startup failed');
  process.exit(1);
});
