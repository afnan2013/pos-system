import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, WEB_BUILD_DIR } from '../src/app.js';
import { HASHED_ASSET_CACHE, REVALIDATE_CACHE } from '../src/platform/http/serve-web.js';
import { buildServices } from '../src/services.js';
import { captureLogs } from './support/logs.js';
import { unreachablePool } from './support/http.js';

const INDEX_HTML = '<!doctype html><title>POS</title><div id="root"></div>';
const ASSET_JS = 'console.log("app")';

let webDir: string;
let pool: Pool;

beforeAll(async () => {
  webDir = await mkdtemp(path.join(tmpdir(), 'pos-web-'));
  await mkdir(path.join(webDir, 'assets'));
  await writeFile(path.join(webDir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(webDir, 'theme.js'), '');
  await writeFile(path.join(webDir, 'assets', 'index-abc123.js'), ASSET_JS);
  pool = unreachablePool();
});

afterAll(async () => {
  await rm(webDir, { recursive: true, force: true });
  await pool.end();
});

function app() {
  return buildApp(buildServices(pool), { webDir });
}

describe('buildApp', () => {
  it('serves the web build from public/ beside the compiled code', () => {
    expect(WEB_BUILD_DIR).toBe(path.resolve(import.meta.dirname, '..', 'public'));
  });

  it('serves index.html at / with no-cache', async () => {
    const response = await request(app()).get('/').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE);
    expect(response.text).toBe(INDEX_HTML);
  });

  it('answers a client-side route with index.html so a reload works', async () => {
    const response = await request(app()).get('/hq/menu').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.text).toBe(INDEX_HTML);
  });

  it('caches hashed assets for a year and other files not at all', async () => {
    const asset = await request(app()).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe(HASHED_ASSET_CACHE);
    expect(asset.text).toBe(ASSET_JS);
    const theme = await request(app()).get('/theme.js');
    expect(theme.headers['cache-control']).toBe(REVALIDATE_CACHE);
  });

  it('answers a missing hashed asset with a 404 problem, never index.html', async () => {
    const response = await request(app()).get('/assets/index-old.js').set('Accept', '*/*');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ type: '/problems/not-found' });
  });

  it('answers a request that does not accept HTML with a 404 problem', async () => {
    const response = await request(app()).get('/logo.png').set('Accept', 'image/png');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ type: '/problems/not-found' });
  });

  it.each(['/api/nope', '/api/v1/nope', '/api'])(
    'answers %s with a 404 problem even when the browser asks for HTML',
    async (pathname) => {
      const response = await request(app()).get(pathname).set('Accept', 'text/html');
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        type: '/problems/not-found',
        title: 'Not found',
        status: 404,
        instance: pathname,
        requestId: response.headers['x-request-id'],
      });
    },
  );

  it('answers a POST to a page with a 404 problem', async () => {
    const response = await request(app()).post('/hq/menu').set('Accept', 'text/html');
    expect(response.status).toBe(404);
  });

  it('sets the request ID and security headers on every response, and hides Express', async () => {
    const response = await request(app()).get('/').set('Accept', 'text/html');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('logs one request line per request, with route static for the web app', async () => {
    const logs = captureLogs();
    const server = request(app());
    await server.get('/hq/menu').set('Accept', 'text/html');
    await server.get('/assets/index-abc123.js');
    await server.get('/api/nope');
    await vi.waitFor(() => {
      expect(logs.records().filter((record) => record['msg'] === 'request')).toHaveLength(3);
    });
    expect(
      logs
        .records()
        .filter((record) => record['msg'] === 'request')
        .map((record) => record['route']),
    ).toEqual(['static', 'static', 'unmatched']);
  });

  it('still serves the API and health when the web build is missing', async () => {
    const apiOnly = buildApp(buildServices(pool), { webDir: path.join(webDir, 'missing') });
    const home = await request(apiOnly).get('/').set('Accept', 'text/html');
    expect(home.status).toBe(404);
    expect(home.body).toMatchObject({ type: '/problems/not-found' });
    const health = await request(apiOnly).get('/healthz');
    expect(health.status).toBe(200);
  });
});
