import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { respond } from '../../../src/platform/http/respond.js';
import { platformApp } from '../../support/http.js';

const app = platformApp((app) => {
  app.get('/created', (_req, res) => {
    respond(res, 201, { id: 'abc' });
  });
  app.get('/empty', (_req, res) => {
    respond(res, 204);
  });
});

describe('respond', () => {
  it('writes JSON that is never cached', async () => {
    const response = await request(app).get('/created');
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ id: 'abc' });
  });

  it('sends no body for 204', async () => {
    const response = await request(app).get('/empty');
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });
});
