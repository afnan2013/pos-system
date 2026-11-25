import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../../src/platform/http/error-handler.js';
import { notFoundHandler } from '../../../src/platform/http/not-found-handler.js';

const app = express();
app.get('/api/known', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api', notFoundHandler);
app.use(errorHandler);

describe('notFoundHandler', () => {
  it.each(['get', 'post', 'delete'] as const)(
    'answers %s on an unknown path with a 404 problem',
    async (method) => {
      const response = await request(app)[method]('/api/missing/path?q=1');
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      expect(response.body).toMatchObject({
        type: '/problems/not-found',
        title: 'Not found',
        status: 404,
        instance: '/api/missing/path',
      });
    },
  );

  it('lets a known path answer normally', async () => {
    const response = await request(app).get('/api/known');
    expect(response.status).toBe(200);
  });

  it('applies only under the path it is mounted on', async () => {
    const response = await request(app).get('/elsewhere');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).not.toContain('problem+json');
  });
});
