import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { HttpSettings } from './config/http.js';
import type { Logger } from './logger/logger.js';
import { logger } from './logger/request-context.js';

export type ClosablePool = {
  end(): Promise<void>;
};

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const IDLE_SWEEP_MS = 100;

export function installProcessHandlers(processLogger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    processLogger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    processLogger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

export async function serveUntilStopped(
  app: Express,
  settings: Pick<HttpSettings, 'port' | 'shutdownTimeoutMs'>,
  pool: ClosablePool,
): Promise<void> {
  const server = await startServer(app, settings.port);
  logger().info({ port: settings.port }, 'listening');
  const signal = await stopSignal();
  logger().info({ signal }, 'shutting down');
  await stopServer(server, pool, settings.shutdownTimeoutMs);
  logger().info('stopped');
}

export async function startServer(app: Express, port: number): Promise<Server> {
  const server = app.listen(port);
  await once(server, 'listening');
  return server;
}

export async function stopServer(
  server: Server,
  pool: ClosablePool,
  timeoutMs: number,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  // close() drops only connections idle at that moment; a keep-alive one that idles later would wait out its timeout.
  const idleSweep = setInterval(() => {
    server.closeIdleConnections();
  }, IDLE_SWEEP_MS);
  const outcome = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  clearInterval(idleSweep);
  if (outcome === 'timeout') {
    logger().warn({ timeoutMs }, 'requests still running at the shutdown timeout, closing them');
    server.closeAllConnections();
    await closed;
  }
  await pool.end();
}

function stopSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      for (const name of STOP_SIGNALS) process.off(name, onSignal);
      resolve(signal);
    };
    for (const name of STOP_SIGNALS) process.once(name, onSignal);
  });
}
