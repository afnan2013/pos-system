import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/platform/config/config-error.js';
import { loadMigrateSettings, loadSettings } from '../../../src/platform/config/settings.js';
import { DEV_TOKEN_KEY_FINGERPRINT } from '../../../src/platform/config/token.js';

// The public, local-only key that .env.example carries.
const DEV_TOKEN_SIGNING_KEY =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZ0hMekV4dEFtYXhXckJYNDQKRk9TYlljTEFHUTZEYnYxSXZubUxrQXZZQllDaFJBTkNBQVJrZHZ1RGZQOWwvSzFyVmhUOURkcGhJZENnZW5yZQp6dXdycWZDeXRtU0ZZTEdOZWFXOW4xVUszWGpxRVl0eVVPTGtORnhEbnZWUTRxZ1hGTTk3QUFlTgotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==';

function freshKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
}

function serverEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: 'local',
    DATABASE_URL: 'postgres://pos_app:hunter2@db:5432/pos',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    TOKEN_SIGNING_KEY: freshKey(),
    ...overrides,
  };
}

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadSettings', () => {
  it('runs every loader', () => {
    const settings = loadSettings(serverEnv());
    expect(settings.base).toEqual({ appEnv: 'local', logLevel: 'info' });
    expect(settings.database.maxConns).toBe(10);
    expect(settings.http.port).toBe(3000);
    expect(settings.token.accessTokenTtlMs).toBe(3_600_000);
  });

  it('collects the problems of every loader into one error', () => {
    expect(problemsOf(() => loadSettings({ DB_MAX_CONNS: '0', ACCESS_TOKEN_TTL: '2d' }))).toEqual([
      'APP_ENV: required (local or prod)',
      'DATABASE_URL: required (a postgres:// URL)',
      'DB_MAX_CONNS: must be a whole number from 1 to 50',
      'PUBLIC_ORIGIN: required (the address people open, such as https://pos.example.com)',
      'TOKEN_SIGNING_KEY: required (base64 of a PKCS#8 PEM ECDSA P-256 private key)',
      'ACCESS_TOKEN_TTL: must be a duration such as 500ms, 10s, 5m or 1h, at most 24h',
    ]);
  });

  it('never echoes a secret in the error', () => {
    const env = serverEnv({ DATABASE_URL: 'mysql://pos_app:hunter2@db/pos', APP_ENV: 'x' });
    expect(() => loadSettings(env)).toThrow(ConfigError);
    expect(problemsOf(() => loadSettings(env)).join('\n')).not.toContain('hunter2');
  });

  it('logs safely: the settings object hides every secret', () => {
    const json = JSON.stringify(loadSettings(serverEnv()));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('PRIVATE KEY');
  });

  it('accepts the dev key locally', () => {
    const settings = loadSettings(serverEnv({ TOKEN_SIGNING_KEY: DEV_TOKEN_SIGNING_KEY }));
    expect(settings.token.signingKeyFingerprint).toBe(DEV_TOKEN_KEY_FINGERPRINT);
  });

  it('refuses the dev key when APP_ENV=prod', () => {
    const env = serverEnv({ APP_ENV: 'prod', TOKEN_SIGNING_KEY: DEV_TOKEN_SIGNING_KEY });
    expect(problemsOf(() => loadSettings(env))).toEqual([
      'TOKEN_SIGNING_KEY: is the public local development key; generate a new key for APP_ENV=prod',
    ]);
  });

  it('accepts a fresh key when APP_ENV=prod', () => {
    expect(loadSettings(serverEnv({ APP_ENV: 'prod' })).base.appEnv).toBe('prod');
  });
});

describe('loadMigrateSettings', () => {
  it('reads MIGRATOR_DATABASE_URL and needs nothing the server needs', () => {
    const settings = loadMigrateSettings({
      APP_ENV: 'prod',
      MIGRATOR_DATABASE_URL: 'postgres://migrator:pw@db:5432/pos',
    });
    expect(settings.database.url.reveal()).toBe('postgres://migrator:pw@db:5432/pos');
  });

  it('collects every problem', () => {
    expect(problemsOf(() => loadMigrateSettings({ DATABASE_URL: 'postgres://a@b/c' }))).toEqual([
      'APP_ENV: required (local or prod)',
      'MIGRATOR_DATABASE_URL: required (a postgres:// URL)',
    ]);
  });
});
