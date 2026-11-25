import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { currentRequestContext, logger } from '../../../src/platform/logger/request-context.js';
import { captureLogs } from '../../support/logs.js';
import { platformApp } from '../../support/http.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function echoApp() {
  return platformApp((app) => {
    app.get('/echo', (_req, res) => {
      logger().info('handler ran');
      res.json({ requestId: currentRequestContext()?.requestId ?? null });
    });
  });
}

describe('requestId', () => {
  it('keeps a valid incoming X-Request-Id and exposes it to the handler', async () => {
    const response = await request(echoApp()).get('/echo').set('X-Request-Id', 'abc.DEF_1-2');
    expect(response.headers['x-request-id']).toBe('abc.DEF_1-2');
    expect(response.body).toEqual({ requestId: 'abc.DEF_1-2' });
  });

  it('generates a UUIDv7 when none is sent', async () => {
    const response = await request(echoApp()).get('/echo');
    expect(response.headers['x-request-id']).toMatch(UUID_V7);
    expect(response.body).toEqual({ requestId: response.headers['x-request-id'] });
  });

  it.each([
    ['too long', 'a'.repeat(65)],
    ['a space', 'abc def'],
    ['a log-injection attempt', 'abc"}\\n{"level":"fatal'],
  ])('replaces an incoming ID with %s', async (_label, incoming) => {
    const response = await request(echoApp()).get('/echo').set('X-Request-Id', incoming);
    expect(response.headers['x-request-id']).toMatch(UUID_V7);
  });

  it('accepts an ID of exactly 64 characters', async () => {
    const incoming = 'b'.repeat(64);
    const response = await request(echoApp()).get('/echo').set('X-Request-Id', incoming);
    expect(response.headers['x-request-id']).toBe(incoming);
  });

  it('gives the request logger the request ID', async () => {
    const logs = captureLogs();
    await request(echoApp()).get('/echo').set('X-Request-Id', 'trace-me');
    expect(logs.records().find((record) => record['msg'] === 'handler ran')).toMatchObject({
      requestId: 'trace-me',
    });
  });
});
