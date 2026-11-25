import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api/ApiError';

const maxQueryRetries = 2;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return (
    failureCount < maxQueryRetries &&
    error instanceof ApiError &&
    (error.kind === 'network' || error.kind === 'unavailable')
  );
}

function toastIfForbidden(error: unknown): void {
  if (error instanceof ApiError && error.kind === 'forbidden') {
    toast.error("You don't have access to do that");
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: toastIfForbidden }),
    mutationCache: new MutationCache({ onError: toastIfForbidden }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
