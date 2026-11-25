import type { Express } from 'express';
import { mapPgError } from '../db/map-pg-error.js';
import { methodNotAllowed } from '../http/method-not-allowed.js';
import { respond } from '../http/respond.js';
import { currentRequestContext } from '../logger/request-context.js';

export const READY_TIMEOUT_MS = 2_000;

export type HealthDatabase = {
  query(text: string): Promise<unknown>;
};

const OK = { status: 'ok' } as const;

export function registerHealthRoutes(app: Express, database: HealthDatabase): void {
  app
    .route('/healthz')
    .get((_req, res) => {
      respond(res, 200, OK);
    })
    .all(methodNotAllowed);

  app
    .route('/readyz')
    .get(async (_req, res) => {
      await checkDatabase(database, currentRequestContext()?.signal);
      respond(res, 200, OK);
    })
    .all(methodNotAllowed);
}

export async function checkDatabase(
  database: HealthDatabase,
  requestSignal: AbortSignal | undefined,
): Promise<void> {
  const timeout = AbortSignal.timeout(READY_TIMEOUT_MS);
  const signal = requestSignal === undefined ? timeout : AbortSignal.any([requestSignal, timeout]);
  try {
    await untilAborted(database.query('SELECT 1'), signal);
  } catch (err) {
    throw mapPgError(err);
  }
}

// The query keeps running after an abort; the pool's own timeouts end it.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
