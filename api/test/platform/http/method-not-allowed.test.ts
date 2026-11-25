import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  methodNotAllowed,
  MethodNotAllowedError,
} from '../../../src/platform/http/method-not-allowed.js';
import { platformApp } from '../../support/http.js';

const app = platformApp((app) => {
  app
    .route('/things')
    .get((_req, res) => {
      res.json([]);
    })
    .post((_req, res) => {
      res.status(201).json({});
    })
    .all(methodNotAllowed);
  app
    .route('/writes')
    .put((_req, res) => {
      res.json({});
    })
    .all(methodNotAllowed);
});

describe('methodNotAllowed', () => {
  it('answers a wrong method with 405 and every allowed method in the Allow header', async () => {
    const response = await request(app).delete('/things');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET, POST, HEAD');
    expect(response.body).toMatchObject({ type: '/problems/method-not-allowed', status: 405 });
  });

  it('leaves HEAD out of the Allow header when the route has no GET', async () => {
    const response = await request(app).get('/writes');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('PUT');
  });

  it('still lets the allowed methods through', async () => {
    const response = await request(app).post('/things');
    expect(response.status).toBe(201);
  });
});

describe('MethodNotAllowedError', () => {
  it('carries the allowed methods', () => {
    const error = new MethodNotAllowedError(['GET', 'HEAD']);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MethodNotAllowedError');
    expect(error.allowed).toEqual(['GET', 'HEAD']);
  });
});
