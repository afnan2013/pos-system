import { z } from 'zod';
import { duration } from './duration.js';
import { parseEnv, wholeNumber, type Env } from './env.js';

export type HttpSettings = {
  readonly port: number;
  readonly publicOrigin: string;
  readonly shutdownTimeoutMs: number;
};

const ORIGIN_EXAMPLE = 'such as https://pos.example.com';
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;

export function loadHttp(env: Env): HttpSettings {
  return parseEnv(env, {
    port: { name: 'HTTP_PORT', schema: wholeNumber(1, 65535, 3000) },
    publicOrigin: { name: 'PUBLIC_ORIGIN', schema: publicOrigin },
    shutdownTimeoutMs: {
      name: 'SHUTDOWN_TIMEOUT',
      schema: duration({ fallback: '10s', maxMs: MAX_SHUTDOWN_TIMEOUT_MS }),
    },
  });
}

const publicOrigin = z
  .string({ error: `required (the address people open, ${ORIGIN_EXAMPLE})` })
  .transform((text, ctx) => {
    const origin = originOf(text);
    if (origin !== undefined) return origin;
    ctx.addIssue(`must be an http or https origin with no path, ${ORIGIN_EXAMPLE}`);
    return z.NEVER;
  });

function originOf(text: string): string | undefined {
  const url = URL.parse(text);
  if (url === null) return undefined;
  const isOriginOnly =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  return isOriginOnly ? url.origin : undefined;
}
