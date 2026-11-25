import { isAxiosError } from 'axios';

export const apiErrorKinds = [
  'validation',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'tooLarge',
  'rateLimited',
  'unavailable',
  'server',
  'network',
  'unknown',
] as const;

export type ApiErrorKind = (typeof apiErrorKinds)[number];

export type ApiErrorFields = Readonly<Record<string, string>>;

const kindByStatus: Readonly<Partial<Record<number, ApiErrorKind>>> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  413: 'tooLarge',
  429: 'rateLimited',
  // 499 means the request was canceled before an answer, so callers treat it like a dropped connection.
  499: 'network',
  503: 'unavailable',
};

const defaultTitles: Readonly<Record<ApiErrorKind, string>> = {
  validation: 'Invalid input',
  unauthorized: 'Authentication required',
  forbidden: 'You do not have permission to do this',
  notFound: 'Not found',
  conflict: 'Conflict',
  tooLarge: 'Request too large',
  rateLimited: 'Too many requests',
  unavailable: 'Service unavailable',
  server: 'Something went wrong on the server',
  network: 'Could not reach the server',
  unknown: 'The request failed',
};

export function kindForStatus(status: number): ApiErrorKind {
  const kind = kindByStatus[status];
  if (kind) return kind;
  if (status >= 500 && status <= 599) return 'server';
  return 'unknown';
}

interface ApiErrorInit {
  kind: ApiErrorKind;
  status?: number | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  fields?: ApiErrorFields | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly title: string;
  readonly detail: string | undefined;
  readonly fields: ApiErrorFields;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    const title = init.title ?? defaultTitles[init.kind];
    super(title, { cause: init.cause });
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.title = title;
    this.detail = init.detail;
    this.fields = init.fields ?? {};
    this.requestId = init.requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toFields(value: unknown): ApiErrorFields {
  if (!isRecord(value)) return {};
  const fields: Record<string, string> = {};
  for (const [name, message] of Object.entries(value)) {
    if (typeof message === 'string') fields[name] = message;
  }
  return fields;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (!isAxiosError(error)) return new ApiError({ kind: 'unknown', cause: error });

  const response = error.response;
  if (!response) return new ApiError({ kind: 'network', cause: error });

  const kind = kindForStatus(response.status);
  const problem = isRecord(response.data) ? response.data : {};
  return new ApiError({
    kind,
    status: response.status,
    title: optionalString(problem.title),
    detail: optionalString(problem.detail),
    fields: toFields(problem.errors),
    requestId:
      optionalString(problem.requestId) ?? optionalString(response.headers['x-request-id']),
    cause: error,
  });
}
