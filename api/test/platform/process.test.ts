import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { serveUntilStopped, startServer, stopServer } from '../../src/platform/process.js';
import { captureLogs } from '../support/logs.js';

function slowApp(delayMs: number) {
  const app = express();
  app.get('/slow', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.json({ done: true });
  });
  return app;
}

function fakePool() {
  return { end: vi.fn(() => Promise.resolve()) };
}

describe('stopServer', () => {
  it('lets an in-flight request finish, then ends the pool', async () => {
    const server = await startServer(slowApp(200), 0);
    const { port } = server.address() as AddressInfo;
    const pool = fakePool();
    const inFlight = fetch(`http://127.0.0.1:${String(port)}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    await stopServer(server, pool, 5_000);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
    expect(server.listening).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('closes requests still running at the timeout', async () => {
    const logs = captureLogs();
    const server = await startServer(slowApp(10_000), 0);
    const { port } = server.address() as AddressInfo;
    const pool = fakePool();
    const inFlight = fetch(`http://127.0.0.1:${String(port)}/slow`).then(
      () => 'answered',
      () => 'cut off',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    await stopServer(server, pool, 300);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await inFlight).toBe('cut off');
    expect(pool.end).toHaveBeenCalledOnce();
    expect(logs.records()).toContainEqual(expect.objectContaining({ level: 'warn' }));
  });
});

describe('serveUntilStopped', () => {
  it('serves until SIGTERM, then stops and ends the pool', async () => {
    const logs = captureLogs();
    const pool = fakePool();
    const app = express();
    app.get('/ping', (_req, res) => {
      res.json({ pong: true });
    });
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    const serving = serveUntilStopped(app, { port, shutdownTimeoutMs: 1_000 }, pool);
    await vi.waitFor(() => {
      expect(logs.records()).toContainEqual(expect.objectContaining({ msg: 'listening' }));
    });
    const response = await fetch(`http://127.0.0.1:${String(port)}/ping`);
    expect(response.status).toBe(200);

    process.emit('SIGTERM');
    await serving;

    expect(pool.end).toHaveBeenCalledOnce();
    expect(logs.records().map((record) => record['msg'])).toEqual(
      expect.arrayContaining(['listening', 'shutting down', 'stopped']),
    );
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});
