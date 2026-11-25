import pg, { type Pool } from 'pg';
import type { DatabaseSettings } from '../config/database.js';
import { logger } from '../logger/request-context.js';
import { int8AsNumber } from './int8.js';

export function createPool(settings: DatabaseSettings): Pool {
  const pool = new pg.Pool({
    connectionString: settings.url.reveal(),
    max: settings.maxConns,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'pos-api',
    types: int8AsNumber,
  });
  pool.on('error', (err) => {
    logger().warn({ err }, 'idle database connection failed');
  });
  return pool;
}
