import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError, ErrNotFound } from '../../../src/platform/errors/app-error.js';
import { kindOf } from '../../../src/platform/errors/kind-of.js';
import { INVALID_BODY_FIELDS, toAppError } from '../../../src/platform/errors/to-app-error.js';

function parserApp() {
  const app = express();
  app.use(express.json({ limit: '64b' }));
  app.post('/', (_req, res) => {
    res.json({ ok: true });
  });
  const handler: ErrorRequestHandler = (err, _req, res, _next) => {
    const appError = toAppError(err);
    res.json({ kind: kindOf(appError), title: appError.title, fields: appError.fields ?? null });
  };
  app.use(handler);
  return app;
}

describe('toAppError', () => {
  it('returns an AppError unchanged', () => {
    expect(toAppError(ErrNotFound)).toBe(ErrNotFound);
  });

  it('wraps anything else as unexpected, keeping it as the cause', () => {
    const cause = new Error('boom');
    const error = toAppError(cause);
    expect(error).toBeInstanceOf(AppError);
    expect(error.kind).toBe('unexpected');
    expect(error.cause).toBe(cause);
  });

  it('turns a malformed JSON body into a fixed validation message', async () => {
    const response = await request(parserApp())
      .post('/')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2",');
    expect(response.body).toEqual({
      kind: 'validation',
      title: 'Invalid input',
      fields: INVALID_BODY_FIELDS,
    });
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('turns an unsupported charset into the same validation message', async () => {
    const response = await request(parserApp())
      .post('/')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}');
    expect(response.body).toMatchObject({ kind: 'validation', fields: INVALID_BODY_FIELDS });
  });

  it('turns an oversized body into too_large', async () => {
    const response = await request(parserApp())
      .post('/')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(100) }));
    expect(response.body).toEqual({ kind: 'too_large', title: 'Request too large', fields: null });
  });

  it.each([
    ['request.aborted', 'canceled'],
    ['encoding.unsupported', 'validation'],
    ['request.size.invalid', 'validation'],
    ['something.else', 'unexpected'],
  ])('maps a body-parser %s error to %s', (type, kind) => {
    expect(toAppError(Object.assign(new Error('parser'), { type })).kind).toBe(kind);
  });
});
