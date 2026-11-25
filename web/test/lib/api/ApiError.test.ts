import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../support/server';
import { ApiError, toApiError, type ApiErrorKind } from '@/lib/api/ApiError';
import { apiClient } from '@/lib/api/client';

const path = '/api/v1/probe';

function problem(status: number, slug: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    {
      type: `/problems/${slug}`,
      title: `Title for ${slug}`,
      status,
      instance: path,
      requestId: 'req-from-body',
      ...extra,
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

async function failingCall(): Promise<ApiError> {
  try {
    await apiClient.get('/v1/probe');
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error('expected an ApiError', { cause: error });
  }
  throw new Error('expected the request to fail');
}

describe('ApiError from a problem document', () => {
  const cases: [number, string, ApiErrorKind][] = [
    [400, 'validation', 'validation'],
    [400, 'invalid-reference', 'validation'],
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not-found', 'notFound'],
    [405, 'method-not-allowed', 'unknown'],
    [409, 'conflict', 'conflict'],
    [413, 'too-large', 'tooLarge'],
    [429, 'rate-limited', 'rateLimited'],
    [499, 'canceled', 'network'],
    [500, 'internal', 'server'],
    [502, 'internal', 'server'],
    [503, 'unavailable', 'unavailable'],
    [504, 'internal', 'server'],
    [418, 'teapot', 'unknown'],
  ];

  it.each(cases)('maps %i %s to kind %s', async (status, slug, kind) => {
    server.use(http.get(path, () => problem(status, slug)));

    const error = await failingCall();

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.title).toBe(`Title for ${slug}`);
    expect(error.message).toBe(`Title for ${slug}`);
    expect(error.requestId).toBe('req-from-body');
  });

  it('turns errors into fields and keeps detail', async () => {
    server.use(
      http.get(path, () =>
        problem(400, 'validation', {
          detail: 'Check the highlighted fields',
          errors: { name: 'Required', 'items[0].quantity': 'must be at least 1', bad: 42 },
        }),
      ),
    );

    const error = await failingCall();

    expect(error.kind).toBe('validation');
    expect(error.detail).toBe('Check the highlighted fields');
    expect(error.fields).toEqual({ name: 'Required', 'items[0].quantity': 'must be at least 1' });
  });

  it('has no fields when the problem has no errors', async () => {
    server.use(http.get(path, () => problem(409, 'conflict')));

    const error = await failingCall();

    expect(error.fields).toEqual({});
    expect(error.detail).toBeUndefined();
  });
});

describe('ApiError from a response that is not a problem document', () => {
  it('handles an HTML body with the default title and the request ID header', async () => {
    server.use(
      http.get(
        path,
        () =>
          new HttpResponse('<html><body>Bad gateway</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-from-header' },
          }),
      ),
    );

    const error = await failingCall();

    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(502);
    expect(error.title).toBe('Something went wrong on the server');
    expect(error.fields).toEqual({});
    expect(error.requestId).toBe('req-from-header');
  });

  it('handles an empty body', async () => {
    server.use(http.get(path, () => new HttpResponse(null, { status: 503 })));

    const error = await failingCall();

    expect(error.kind).toBe('unavailable');
    expect(error.title).toBe('Service unavailable');
    expect(error.requestId).toBeUndefined();
  });

  it('handles a JSON body that is not an object', async () => {
    server.use(http.get(path, () => HttpResponse.json(['unexpected'], { status: 404 })));

    const error = await failingCall();

    expect(error.kind).toBe('notFound');
    expect(error.title).toBe('Not found');
  });
});

describe('ApiError with no response', () => {
  it('is kind network with no status when the connection fails', async () => {
    server.use(http.get(path, () => HttpResponse.error()));

    const error = await failingCall();

    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.title).toBe('Could not reach the server');
  });
});

describe('toApiError', () => {
  it('returns an ApiError unchanged', () => {
    const original = new ApiError({ kind: 'conflict', status: 409 });

    expect(toApiError(original)).toBe(original);
  });

  it('treats an error that did not come from axios as unknown', () => {
    const cause = new TypeError('boom');

    const error = toApiError(cause);

    expect(error.kind).toBe('unknown');
    expect(error.status).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});
