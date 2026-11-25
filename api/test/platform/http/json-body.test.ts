import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { INVALID_BODY_FIELDS } from '../../../src/platform/errors/to-app-error.js';
import { currentRequestContext, logger } from '../../../src/platform/logger/request-context.js';
import { captureLogs } from '../../support/logs.js';
import { platformApp } from '../../support/http.js';

const app = platformApp((app) => {
  app.post('/notes', (req, res) => {
    logger().info('note received');
    res.json({ requestId: currentRequestContext()?.requestId ?? null, body: req.body as unknown });
  });
});

describe('jsonBody', () => {
  it('keeps the request context after parsing the body', async () => {
    const logs = captureLogs();
    const response = await request(app)
      .post('/notes')
      .set('X-Request-Id', 'after-parse')
      .send({ note: 'hello' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requestId: 'after-parse', body: { note: 'hello' } });
    await vi.waitFor(() => {
      expect(logs.records().find((record) => record['msg'] === 'note received')).toMatchObject({
        requestId: 'after-parse',
      });
    });
  });

  it('keeps the request context when the body arrives after the headers', async () => {
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ note: 'late' });
      const answer = new Promise<string>((resolve, reject) => {
        const client = httpRequest(
          {
            port,
            method: 'POST',
            path: '/notes',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(body)),
              'X-Request-Id': 'late-body',
            },
          },
          (response) => {
            let text = '';
            response.on('data', (chunk: Buffer) => (text += chunk.toString()));
            response.on('end', () => {
              resolve(text);
            });
          },
        );
        client.on('error', reject);
        client.flushHeaders();
        void sleep(50).then(() => client.end(body));
      });
      expect(JSON.parse(await answer)).toEqual({ requestId: 'late-body', body: { note: 'late' } });
    } finally {
      server.close();
    }
  });

  it('answers a malformed body with a fixed message that never quotes it', async () => {
    const response = await request(app)
      .post('/notes')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2",');
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(response.body).toMatchObject({
      type: '/problems/validation',
      title: 'Invalid input',
      status: 400,
      errors: INVALID_BODY_FIELDS,
    });
    expect(response.text).not.toContain('hunter2');
  });

  it('refuses a JSON body that is not an object or array', async () => {
    const response = await request(app)
      .post('/notes')
      .set('Content-Type', 'application/json')
      .send('"just a string"');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errors: INVALID_BODY_FIELDS });
  });

  it('answers a body over 1 MB with 413', async () => {
    const response = await request(app)
      .post('/notes')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      type: '/problems/too-large',
      title: 'Request too large',
      status: 413,
    });
    expect(response.body).not.toHaveProperty('errors');
  });
});
