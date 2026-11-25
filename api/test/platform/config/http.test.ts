import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/platform/config/config-error.js';
import { loadHttp } from '../../../src/platform/config/http.js';

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadHttp', () => {
  it('reads the settings', () => {
    expect(
      loadHttp({
        HTTP_PORT: '8080',
        PUBLIC_ORIGIN: 'https://pos.example.com/',
        SHUTDOWN_TIMEOUT: '30s',
      }),
    ).toEqual({ port: 8080, publicOrigin: 'https://pos.example.com', shutdownTimeoutMs: 30_000 });
  });

  it('defaults the port to 3000 and the shutdown timeout to 10s', () => {
    expect(loadHttp({ PUBLIC_ORIGIN: 'http://localhost:3000' })).toEqual({
      port: 3000,
      publicOrigin: 'http://localhost:3000',
      shutdownTimeoutMs: 10_000,
    });
  });

  it('reports every bad setting at once', () => {
    expect(problemsOf(() => loadHttp({ HTTP_PORT: '70000', SHUTDOWN_TIMEOUT: 'soon' }))).toEqual([
      'HTTP_PORT: must be a whole number from 1 to 65535',
      'PUBLIC_ORIGIN: required (the address people open, such as https://pos.example.com)',
      'SHUTDOWN_TIMEOUT: must be a duration such as 500ms, 10s, 5m or 1h',
    ]);
  });

  it.each([
    'pos.example.com',
    'ftp://pos.example.com',
    'https://pos.example.com/app',
    'https://pos.example.com?x=1',
    'https://user:pass@pos.example.com',
  ])('rejects PUBLIC_ORIGIN=%s', (origin) => {
    expect(problemsOf(() => loadHttp({ PUBLIC_ORIGIN: origin }))).toEqual([
      'PUBLIC_ORIGIN: must be an http or https origin with no path, such as https://pos.example.com',
    ]);
  });

  it('rejects a zero shutdown timeout', () => {
    expect(
      problemsOf(() =>
        loadHttp({ PUBLIC_ORIGIN: 'http://localhost:3000', SHUTDOWN_TIMEOUT: '0s' }),
      ),
    ).toEqual(['SHUTDOWN_TIMEOUT: must be a duration such as 500ms, 10s, 5m or 1h']);
  });
});
