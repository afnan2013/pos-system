import { AppEnv, loadBase, type BaseSettings } from './base.js';
import { ConfigError } from './config-error.js';
import { loadDatabase, type DatabaseSettings } from './database.js';
import type { Env } from './env.js';
import { loadHttp, type HttpSettings } from './http.js';
import { DEV_TOKEN_KEY_FINGERPRINT, loadTokenSettings, type TokenSettings } from './token.js';

export type Settings = {
  readonly base: BaseSettings;
  readonly database: DatabaseSettings;
  readonly http: HttpSettings;
  readonly token: TokenSettings;
};

export type MigrateSettings = {
  readonly base: BaseSettings;
  readonly database: DatabaseSettings;
};

export function loadSettings(env: Env): Settings {
  const problems: string[] = [];
  const base = collect(problems, () => loadBase(env));
  const database = collect(problems, () => loadDatabase(env));
  const http = collect(problems, () => loadHttp(env));
  const token = collect(problems, () => loadTokenSettings(env));
  if (base?.appEnv === AppEnv.Prod && token?.signingKeyFingerprint === DEV_TOKEN_KEY_FINGERPRINT) {
    problems.push(
      'TOKEN_SIGNING_KEY: is the public local development key; generate a new key for APP_ENV=prod',
    );
  }
  if (problems.length > 0 || !base || !database || !http || !token) {
    throw new ConfigError(problems);
  }
  return { base, database, http, token };
}

export function loadMigrateSettings(env: Env): MigrateSettings {
  const problems: string[] = [];
  const base = collect(problems, () => loadBase(env));
  const database = collect(problems, () => loadDatabase(env, 'MIGRATOR_DATABASE_URL'));
  if (problems.length > 0 || !base || !database) throw new ConfigError(problems);
  return { base, database };
}

function collect<T>(problems: string[], load: () => T): T | undefined {
  try {
    return load();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
    return undefined;
  }
}
