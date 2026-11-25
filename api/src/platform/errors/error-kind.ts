export const ErrorKind = {
  Validation: 'validation',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  InvalidReference: 'invalid_reference',
  TooLarge: 'too_large',
  RateLimited: 'rate_limited',
  Unavailable: 'unavailable',
  Canceled: 'canceled',
  Unexpected: 'unexpected',
} as const;
export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

export type ProblemSpec = {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly logAt: 'error' | 'warn' | 'info' | 'none';
};

export const problemSpecs: Readonly<Record<ErrorKind, ProblemSpec>> = {
  validation: { status: 400, slug: 'validation', title: 'Invalid input', logAt: 'none' },
  unauthorized: {
    status: 401,
    slug: 'unauthorized',
    title: 'Authentication required',
    logAt: 'none',
  },
  forbidden: {
    status: 403,
    slug: 'forbidden',
    title: 'You do not have permission to do this',
    logAt: 'none',
  },
  not_found: { status: 404, slug: 'not-found', title: 'Not found', logAt: 'none' },
  conflict: { status: 409, slug: 'conflict', title: 'Conflict', logAt: 'none' },
  invalid_reference: {
    status: 400,
    slug: 'invalid-reference',
    title: 'Refers to something that does not exist',
    logAt: 'none',
  },
  too_large: { status: 413, slug: 'too-large', title: 'Request too large', logAt: 'none' },
  rate_limited: { status: 429, slug: 'rate-limited', title: 'Too many requests', logAt: 'none' },
  unavailable: { status: 503, slug: 'unavailable', title: 'Service unavailable', logAt: 'warn' },
  canceled: { status: 499, slug: 'canceled', title: 'Request canceled', logAt: 'info' },
  unexpected: { status: 500, slug: 'internal', title: 'Internal Server Error', logAt: 'error' },
};
