import { describe, expect, it } from 'vitest';
import { loadBase } from '../../../src/platform/config/base.js';
import { ConfigError } from '../../../src/platform/config/config-error.js';

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadBase', () => {
  it('reads the settings', () => {
    expect(loadBase({ APP_ENV: 'prod', LOG_LEVEL: 'warn' })).toEqual({
      appEnv: 'prod',
      logLevel: 'warn',
    });
  });

  it('defaults LOG_LEVEL to info, also when it is blank', () => {
    expect(loadBase({ APP_ENV: 'local' }).logLevel).toBe('info');
    expect(loadBase({ APP_ENV: 'local', LOG_LEVEL: '' }).logLevel).toBe('info');
  });

  it('reports every bad setting at once', () => {
    expect(problemsOf(() => loadBase({ LOG_LEVEL: 'verbose' }))).toEqual([
      'APP_ENV: required (local or prod)',
      'LOG_LEVEL: must be debug, info, warn or error',
    ]);
  });

  it('has no default for APP_ENV', () => {
    expect(problemsOf(() => loadBase({ APP_ENV: 'staging' }))).toEqual([
      'APP_ENV: required (local or prod)',
    ]);
  });

  it('refuses LOG_LEVEL=debug when APP_ENV=prod', () => {
    expect(problemsOf(() => loadBase({ APP_ENV: 'prod', LOG_LEVEL: 'debug' }))).toEqual([
      'LOG_LEVEL: debug is for local use only; use info, warn or error',
    ]);
    expect(loadBase({ APP_ENV: 'local', LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('lists the problems in the error message', () => {
    expect(() => loadBase({})).toThrow(
      'Invalid configuration:\n  - APP_ENV: required (local or prod)',
    );
  });
});
