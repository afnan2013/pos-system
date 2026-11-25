import { z } from 'zod';
import { parseEnv, wholeNumber, type Env } from './env.js';
import { Secret } from './secret.js';

export type DatabaseUrlName = 'DATABASE_URL' | 'MIGRATOR_DATABASE_URL';

export type DatabaseSettings = {
  readonly url: Secret;
  readonly maxConns: number;
};

export function loadDatabase(
  env: Env,
  urlName: DatabaseUrlName = 'DATABASE_URL',
): DatabaseSettings {
  return parseEnv(env, {
    url: { name: urlName, schema: postgresUrl },
    maxConns: { name: 'DB_MAX_CONNS', schema: wholeNumber(1, 50, 10) },
  });
}

// URL parse errors quote the whole input, password included, so the message is fixed.
const postgresUrl = z.string({ error: 'required (a postgres:// URL)' }).transform((text, ctx) => {
  if (isPostgresUrl(text)) return new Secret(text);
  ctx.addIssue('not a valid postgres URL');
  return z.NEVER;
});

function isPostgresUrl(text: string): boolean {
  const url = URL.parse(text);
  return (
    url !== null &&
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.hostname !== ''
  );
}
