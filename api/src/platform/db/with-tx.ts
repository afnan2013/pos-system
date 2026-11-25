import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger/request-context.js';
import type { Tx } from './db.js';
import { mapPgError } from './map-pg-error.js';

const ROLLBACK_TIMEOUT_MS = 5_000;

async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    throw mapPgError(err);
  }
}

async function rollbackWithin(client: PoolClient, timeoutMs: number): Promise<Error | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ROLLBACK did not finish within ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([client.query('ROLLBACK'), timeout]);
    return undefined;
  } catch (err) {
    const rollbackError = err instanceof Error ? err : new Error('ROLLBACK failed', { cause: err });
    logger().warn({ err: rollbackError }, 'transaction rollback failed, discarding the connection');
    return rollbackError;
  } finally {
    clearTimeout(timer);
  }
}

export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connect(pool);
  let connectionError: Error | undefined;
  // A checked-out client that loses its connection emits 'error'; unheard, that crashes the process.
  const onConnectionError = (err: Error) => {
    connectionError = err;
  };
  client.on('error', onConnectionError);
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client as Tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    releaseError = await rollbackWithin(client, ROLLBACK_TIMEOUT_MS);
    throw mapPgError(err);
  } finally {
    client.off('error', onConnectionError);
    client.release(releaseError ?? connectionError);
  }
}
