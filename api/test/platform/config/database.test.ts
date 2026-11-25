import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/platform/config/config-error.js';
import { loadDatabase } from '../../../src/platform/config/database.js';

const URL_WITH_PASSWORD = 'postgres://pos_app:hunter2@db:5432/pos';

function configError(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadDatabase', () => {
  it('reads the settings and holds the URL as a secret', () => {
    const settings = loadDatabase({ DATABASE_URL: URL_WITH_PASSWORD, DB_MAX_CONNS: '20' });
    expect(settings.url.reveal()).toBe(URL_WITH_PASSWORD);
    expect(settings.maxConns).toBe(20);
    expect(JSON.stringify(settings)).not.toContain('hunter2');
  });

  it('defaults DB_MAX_CONNS to 10 and accepts postgresql://', () => {
    const settings = loadDatabase({ DATABASE_URL: 'postgresql://u:p@localhost/pos' });
    expect(settings.maxConns).toBe(10);
  });

  it('reads MIGRATOR_DATABASE_URL for the migrate CLI', () => {
    const settings = loadDatabase(
      { DATABASE_URL: 'postgres://other@db/pos', MIGRATOR_DATABASE_URL: URL_WITH_PASSWORD },
      'MIGRATOR_DATABASE_URL',
    );
    expect(settings.url.reveal()).toBe(URL_WITH_PASSWORD);
    expect(configError(() => loadDatabase({}, 'MIGRATOR_DATABASE_URL')).problems).toEqual([
      'MIGRATOR_DATABASE_URL: required (a postgres:// URL)',
    ]);
  });

  it('reports every bad setting at once', () => {
    expect(configError(() => loadDatabase({ DB_MAX_CONNS: '51' })).problems).toEqual([
      'DATABASE_URL: required (a postgres:// URL)',
      'DB_MAX_CONNS: must be a whole number from 1 to 50',
    ]);
  });

  it.each(['0', '1.5', 'ten', '-3'])('rejects DB_MAX_CONNS=%s', (value) => {
    expect(
      configError(() => loadDatabase({ DATABASE_URL: URL_WITH_PASSWORD, DB_MAX_CONNS: value }))
        .problems,
    ).toEqual(['DB_MAX_CONNS: must be a whole number from 1 to 50']);
  });

  it.each([
    'mysql://pos_app:hunter2@db/pos',
    'postgres://pos_app:hunter2@',
    'hunter2 not a url',
    'postgres://pos_app:hunter2@[db/pos',
  ])('rejects %s without echoing it', (url) => {
    const error = configError(() => loadDatabase({ DATABASE_URL: url }));
    expect(error.problems).toEqual(['DATABASE_URL: not a valid postgres URL']);
    expect(error.message).not.toContain('hunter2');
  });
});
