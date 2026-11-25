import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { methodNotAllowed } from '../../../src/platform/http/method-not-allowed.js';
import { recordRoutePrefix } from '../../../src/platform/http/route-pattern.js';
import { captureLogs, type LogRecord } from '../../support/logs.js';
import { platformApp } from '../../support/http.js';

function requestLines(records: LogRecord[]): LogRecord[] {
  return records.filter((record) => record['msg'] === 'request');
}

function routedApp(onHang?: () => void) {
  const v1 = express.Router();
  v1.route('/outlets/:outletId/sales')
    .get((_req, res) => {
      res.json({ items: [] });
    })
    .all(methodNotAllowed);
  return platformApp((app) => {
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.get('/hang', () => {
      onHang?.();
    });
    app.use('/api/v1', recordRoutePrefix, v1);
  });
}

describe('requestLog', () => {
  it('writes exactly one line with the route pattern, never the raw path', async () => {
    const logs = captureLogs();
    const response = await request(routedApp())
      .get('/api/v1/outlets/0193b6f0-2a4c-7c1e-9d2b-5f0a1e3c4d5e/sales?after=x')
      .set('X-Request-Id', 'one-line');
    await vi.waitFor(() => {
      expect(requestLines(logs.records())).toHaveLength(1);
    });
    const [line] = requestLines(logs.records());
    expect(line).toEqual({
      level: 'info',
      time: expect.any(String) as unknown,
      msg: 'request',
      requestId: 'one-line',
      method: 'GET',
      route: '/api/v1/outlets/:outletId/sales',
      status: 200,
      durationMs: expect.any(Number) as unknown,
      bytes: Number(response.headers['content-length']),
    });
    expect(JSON.stringify(line)).not.toContain('0193b6f0');
  });

  it('records the pattern for a 405 from a mounted router', async () => {
    const logs = captureLogs();
    await request(routedApp()).delete('/api/v1/outlets/abc/sales');
    await vi.waitFor(() => {
      expect(requestLines(logs.records())).toHaveLength(1);
    });
    expect(requestLines(logs.records())[0]).toMatchObject({
      method: 'DELETE',
      route: '/api/v1/outlets/:outletId/sales',
      status: 405,
    });
  });

  it('records unmatched for a path no route knows', async () => {
    const logs = captureLogs();
    await request(routedApp()).get('/api/v1/nothing/here');
    await vi.waitFor(() => {
      expect(requestLines(logs.records())).toHaveLength(1);
    });
    expect(requestLines(logs.records())[0]).toMatchObject({ route: 'unmatched', status: 404 });
  });

  it('writes one request line and one error line for a failing request', async () => {
    const logs = captureLogs();
    await request(routedApp()).get('/boom');
    await vi.waitFor(() => {
      expect(requestLines(logs.records())).toHaveLength(1);
    });
    expect(requestLines(logs.records())[0]).toMatchObject({ route: '/boom', status: 500 });
    expect(logs.records().filter((record) => record['level'] === 'error')).toHaveLength(1);
  });

  it('writes the line on close with aborted when the client hangs up', async () => {
    const logs = captureLogs();
    let hung: () => void = () => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      hung = resolve;
    });
    const server = routedApp(hung).listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const client = httpRequest({ port, path: '/hang' });
      client.on('error', () => undefined);
      client.end();
      await handlerStarted;
      client.destroy();
      await vi.waitFor(() => {
        expect(requestLines(logs.records())).toHaveLength(1);
      });
      expect(requestLines(logs.records())[0]).toMatchObject({ route: '/hang', aborted: true });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
