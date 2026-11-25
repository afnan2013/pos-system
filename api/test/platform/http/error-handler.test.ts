import { DatabaseError } from 'pg';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  conflict,
  ErrForbidden,
  unavailable,
  unexpected,
  validation,
} from '../../../src/platform/errors/app-error.js';
import { withTitle } from '../../../src/platform/errors/kind-of.js';
import { mapPgError } from '../../../src/platform/db/map-pg-error.js';
import { methodNotAllowed } from '../../../src/platform/http/method-not-allowed.js';
import { captureLogs, type LogRecord } from '../../support/logs.js';
import { platformApp } from '../../support/http.js';

function checkViolation(): DatabaseError {
  const error = new DatabaseError(
    'new row for relation "stock" violates check constraint "stock_quantity_check"',
    0,
    'error',
  );
  error.code = '23514';
  error.constraint = 'stock_quantity_check';
  error.detail = 'Failing row contains (secret-value, -5).';
  return error;
}

function failedQuery(code: string, message: string, fields: Partial<DatabaseError>): DatabaseError {
  const error = new DatabaseError(message, 0, 'error');
  Object.assign(error, { code, where: "unnamed portal parameter $1 = 'secret-param'" }, fields);
  return error;
}

const notNullViolation = () =>
  failedQuery(
    '23502',
    'null value in column "name" of relation "menu_items" violates not-null constraint',
    {
      schema: 'pos',
      table: 'menu_items',
      column: 'name',
      routine: 'ExecConstraints',
      detail: 'Failing row contains (secret-row, null).',
    },
  );

const invalidText = () =>
  failedQuery('22P02', 'invalid input syntax for type uuid: "secret-input"', {
    routine: 'string_to_uuid',
  });

const ErrInsufficientStock = conflict('Not enough stock');

const app = platformApp((app) => {
  app.get('/boom', () => {
    throw new Error('SELECT password FROM users');
  });
  app.get('/rejects', async () => {
    await Promise.resolve();
    throw unexpected(new Error('deep secret'));
  });
  app.get('/stock', () => {
    throw withTitle(ErrInsufficientStock, 'Not enough stock for Iced Latte');
  });
  app.get('/forbidden', () => {
    throw ErrForbidden;
  });
  app.get('/fields', () => {
    throw validation({ 'items[1].quantity': 'must be at least 1' });
  });
  app.get('/check', () => {
    throw mapPgError(checkViolation());
  });
  app.get('/not-null', () => {
    throw mapPgError(notNullViolation());
  });
  app.get('/bad-text', () => {
    throw mapPgError(invalidText());
  });
  app.get('/down', () => {
    throw unavailable(
      undefined,
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
  });
  app.get('/timeout', () => {
    throw unexpected(new DOMException('The operation timed out', 'TimeoutError'));
  });
  app.get('/canceled', () => {
    throw unexpected(new DOMException('This operation was aborted', 'AbortError'));
  });
  app.get('/half-sent', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('partial');
    throw new Error('stream failed');
  });
  app
    .route('/only-get')
    .get((_req, res) => {
      res.json({ ok: true });
    })
    .all(methodNotAllowed);
});

function nonRequestLines(records: LogRecord[]): LogRecord[] {
  return records.filter((record) => record['msg'] !== 'request');
}

describe('errorHandler', () => {
  it('answers an unexpected throw with a bare 500 and logs it once at error', async () => {
    const logs = captureLogs();
    const response = await request(app).get('/boom?token=abc').set('X-Request-Id', 'req-500');
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      type: '/problems/internal',
      title: 'Internal Server Error',
      status: 500,
      instance: '/boom',
      requestId: 'req-500',
    });
    expect(response.text).not.toContain('password');
    const errors = logs.records().filter((record) => record['level'] === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      requestId: 'req-500',
      route: '/boom',
      msg: 'unexpected error',
    });
    expect(JSON.stringify(errors[0])).toContain('SELECT password FROM users');
  });

  it('handles a rejected promise from an async handler', async () => {
    const response = await request(app).get('/rejects');
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('deep secret');
  });

  it('uses an area error title and kind, and logs nothing for a 409', async () => {
    const logs = captureLogs();
    const response = await request(app).get('/stock');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      type: '/problems/conflict',
      title: 'Not enough stock for Iced Latte',
      status: 409,
    });
    expect(response.body).not.toHaveProperty('errors');
    await vi.waitFor(() => {
      expect(logs.records()).toHaveLength(1);
    });
    expect(nonRequestLines(logs.records())).toEqual([]);
  });

  it('answers 403 with the default title', async () => {
    const response = await request(app).get('/forbidden');
    expect(response.body).toMatchObject({
      type: '/problems/forbidden',
      title: 'You do not have permission to do this',
      status: 403,
    });
  });

  it('lists field errors only for validation', async () => {
    const response = await request(app).get('/fields');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      type: '/problems/validation',
      errors: { 'items[1].quantity': 'must be at least 1' },
    });
  });

  it('answers a check violation generically and logs only its constraint and SQLSTATE', async () => {
    const logs = captureLogs();
    const response = await request(app).get('/check');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ type: '/problems/validation', title: 'Invalid input' });
    expect(response.body).not.toHaveProperty('errors');
    expect(response.text).not.toContain('stock_quantity_check');
    const lines = nonRequestLines(logs.records());
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'database rejected the input',
        constraint: 'stock_quantity_check',
        sqlState: '23514',
        route: '/check',
      }) as unknown,
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret-value');
  });

  it.each([
    ['/not-null', '23502', { table: 'menu_items', column: 'name', routine: 'ExecConstraints' }],
    ['/bad-text', '22P02', { routine: 'string_to_uuid' }],
  ])(
    'logs a 500 from %s by SQLSTATE %s and names only, never values',
    async (path, sqlState, names) => {
      const logs = captureLogs();
      const response = await request(app).get(path);
      expect(response.status).toBe(500);
      const errors = logs.records().filter((record) => record['level'] === 'error');
      expect(errors).toEqual([
        expect.objectContaining({
          msg: 'unexpected error',
          route: path,
          err: expect.objectContaining({
            type: 'AppError',
            database: expect.objectContaining({ sqlState, ...names }) as unknown,
          }) as unknown,
        }) as unknown,
      ]);
      const text = JSON.stringify(logs.records());
      expect(text).not.toContain('secret');
      expect(text).not.toContain('Failing row');
    },
  );

  it('answers unavailable with 503 and logs a warning without a stack', async () => {
    const logs = captureLogs();
    const response = await request(app).get('/down');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ type: '/problems/unavailable', status: 503 });
    const [line] = nonRequestLines(logs.records());
    expect(line).toMatchObject({ level: 'warn', kind: 'unavailable' });
    expect(JSON.stringify(line)).not.toContain('"stack"');
    expect(JSON.stringify(line)).toContain('ECONNREFUSED');
  });

  it('reports a wrapped timeout as unavailable with the default title', async () => {
    const response = await request(app).get('/timeout');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ title: 'Service unavailable' });
  });

  it('reports a wrapped abort as canceled (499) and logs it at info', async () => {
    const logs = captureLogs();
    const response = await request(app).get('/canceled');
    expect(response.status).toBe(499);
    expect(response.body).toMatchObject({ type: '/problems/canceled', title: 'Request canceled' });
    expect(nonRequestLines(logs.records())).toEqual([
      expect.objectContaining({ level: 'info', kind: 'canceled' }) as unknown,
    ]);
  });

  it('answers an unknown path with a 404 problem', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      type: '/problems/not-found',
      title: 'Not found',
      status: 404,
      instance: '/nope',
    });
  });

  it('answers a wrong method with 405 and an Allow header, and logs nothing', async () => {
    const logs = captureLogs();
    const response = await request(app).post('/only-get');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD');
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(response.body).toMatchObject({
      type: '/problems/method-not-allowed',
      title: 'Method not allowed',
      status: 405,
    });
    await vi.waitFor(() => {
      expect(logs.records()).toHaveLength(1);
    });
    expect(nonRequestLines(logs.records())).toEqual([]);
  });

  it('destroys the socket when the response already started', async () => {
    const logs = captureLogs();
    await expect(request(app).get('/half-sent')).rejects.toThrow();
    const errors = logs.records().filter((record) => record['level'] === 'error');
    expect(errors).toEqual([
      expect.objectContaining({ msg: 'error after response started' }) as unknown,
    ]);
  });
});
