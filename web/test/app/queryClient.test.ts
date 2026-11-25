import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorKind } from '@/lib/api/ApiError';
import { createQueryClient, shouldRetryQuery } from '@/app/queryClient';

describe('shouldRetryQuery', () => {
  it.each<ApiErrorKind>(['network', 'unavailable'])('retries kind %s up to two times', (kind) => {
    const error = new ApiError({ kind });

    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(false);
  });

  it.each<ApiErrorKind>(['validation', 'unauthorized', 'forbidden', 'notFound', 'server'])(
    'never retries kind %s',
    (kind) => {
      expect(shouldRetryQuery(0, new ApiError({ kind }))).toBe(false);
    },
  );

  it('never retries an error that is not an ApiError', () => {
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('uses the agreed defaults', () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();

    expect(queries).toMatchObject({
      staleTime: 30_000,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    });
    expect(mutations?.retry).toBe(false);
  });
});
