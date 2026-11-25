import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../support/server';
import { ApiError } from '@/lib/api/ApiError';
import { apiClient } from '@/lib/api/client';

describe('apiClient', () => {
  it('sends requests under /api and returns the response data', async () => {
    server.use(http.get('/api/v1/ping', () => HttpResponse.json({ ok: true })));

    const response = await apiClient.get<{ ok: boolean }>('/v1/ping');

    expect(response.data).toEqual({ ok: true });
  });

  it('rejects a failed response with an ApiError', async () => {
    server.use(
      http.get('/api/v1/secret', () =>
        HttpResponse.json(
          { type: '/problems/forbidden', title: 'No access', status: 403, requestId: 'req-403' },
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const rejection: unknown = await apiClient.get('/v1/secret').catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ApiError);
    expect(rejection).toMatchObject({
      kind: 'forbidden',
      status: 403,
      title: 'No access',
      requestId: 'req-403',
    });
  });

  it('rejects a connection failure with an ApiError of kind network', async () => {
    server.use(http.get('/api/v1/ping', () => HttpResponse.error()));

    await expect(apiClient.get('/v1/ping')).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'network',
    });
  });
});
