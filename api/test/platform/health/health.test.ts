import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { Secret } from '../../../src/platform/config/secret.js';
import { createPool } from '../../../src/platform/db/create-pool.js';
import { READY_TIMEOUT_MS } from '../../../src/platform/health/health.js';
import { buildServices } from '../../../src/services.js';
import { captureLogs } from '../../support/logs.js';
import { unreachablePool } from '../../support/http.js';
import {
  CONTAINER_START_TIMEOUT_MS,
  startTestDatabase,
  type TestDatabase,
} from '../../support/postgres.js';

function appWith(pool: Pool) {
  return buildApp(buildServices(pool), { webDir: '/nonexistent' });
}

describe('health routes', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    pool = createPool({ url: new Secret(database.appUrl), maxConns: 2 });
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  it('GET /healthz answers ok without touching the database', async () => {
    const query = vi.spyOn(pool, 'query');
    const response = await request(appWith(pool)).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });

  it('GET /readyz answers ok when Postgres answers', async () => {
    const response = await request(appWith(pool)).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('answers a wrong method on a health route with 405', async () => {
    const response = await request(appWith(pool)).post('/readyz');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD');
  });
});

describe('GET /readyz when Postgres is down', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = unreachablePool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('answers a 503 problem and logs a warning', async () => {
    const logs = captureLogs();
    const response = await request(appWith(pool)).get('/readyz');
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(response.body).toMatchObject({
      type: '/problems/unavailable',
      title: 'Service unavailable',
      status: 503,
      instance: '/readyz',
    });
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'warn', kind: 'unavailable', route: '/readyz' }),
    );
  });

  it('keeps /healthz at 200', async () => {
    const response = await request(appWith(pool)).get('/healthz');
    expect(response.status).toBe(200);
  });
});

describe('GET /readyz when Postgres does not answer', () => {
  let silentServer: Server;
  const sockets = new Set<Socket>();
  let pool: Pool;

  beforeAll(async () => {
    silentServer = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
    const { port } = silentServer.address() as AddressInfo;
    pool = createPool({
      url: new Secret(`postgres://nobody:nothing@127.0.0.1:${String(port)}/pos`),
      maxConns: 1,
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silentServer.close(resolve));
    await pool.end().catch(() => undefined);
  });

  it(`gives up after ${String(READY_TIMEOUT_MS)} ms with a 503 problem`, async () => {
    const startedAt = Date.now();
    const response = await request(appWith(pool)).get('/readyz');
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ type: '/problems/unavailable' });
    expect(elapsedMs).toBeGreaterThanOrEqual(READY_TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(READY_TIMEOUT_MS + 1_500);
  });
});
