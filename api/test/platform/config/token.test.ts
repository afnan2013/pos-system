import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/platform/config/config-error.js';
import { keyFingerprint, loadTokenSettings } from '../../../src/platform/config/token.js';

function base64Pem(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64');
}

function ecKey(namedCurve: string): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve });
  return base64Pem(privateKey.export({ type: 'pkcs8', format: 'pem' }));
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

const KEY_PROBLEM = 'TOKEN_SIGNING_KEY: must be base64 of a PKCS#8 PEM ECDSA P-256 private key';

describe('loadTokenSettings', () => {
  it('decodes the key to its PEM, held as a secret, and defaults the TTL to 1h', () => {
    const encoded = ecKey('P-256');
    const settings = loadTokenSettings({ TOKEN_SIGNING_KEY: encoded });
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    expect(settings.signingKey.reveal()).toBe(pem);
    expect(settings.signingKeyFingerprint).toBe(keyFingerprint(createPrivateKey(pem)));
    expect(settings.accessTokenTtlMs).toBe(3_600_000);
    expect(JSON.stringify(settings)).not.toContain('PRIVATE KEY');
  });

  it('accepts a TTL up to 24h', () => {
    const settings = loadTokenSettings({
      TOKEN_SIGNING_KEY: ecKey('P-256'),
      ACCESS_TOKEN_TTL: '24h',
    });
    expect(settings.accessTokenTtlMs).toBe(86_400_000);
  });

  it('reports every bad setting at once', () => {
    expect(problemsOf(() => loadTokenSettings({ ACCESS_TOKEN_TTL: '25h' }))).toEqual([
      'TOKEN_SIGNING_KEY: required (base64 of a PKCS#8 PEM ECDSA P-256 private key)',
      'ACCESS_TOKEN_TTL: must be a duration such as 500ms, 10s, 5m or 1h, at most 24h',
    ]);
  });

  it.each([
    ['not base64', 'not base64!'],
    ['base64 of something else', base64Pem('hello')],
    ['a P-384 key', ecKey('P-384')],
    [
      'a SEC1 PEM',
      base64Pem(
        generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
          type: 'sec1',
          format: 'pem',
        }),
      ),
    ],
    [
      'an RSA key',
      base64Pem(
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
          type: 'pkcs8',
          format: 'pem',
        }),
      ),
    ],
    ['truncated base64', ecKey('P-256').slice(0, 20)],
  ])('rejects %s without echoing it', (_, value) => {
    expect(problemsOf(() => loadTokenSettings({ TOKEN_SIGNING_KEY: value }))).toEqual([
      KEY_PROBLEM,
    ]);
  });

  it('gives the same fingerprint for the same key in a different encoding', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const crlf = pkcs8.replaceAll('\n', '\r\n');
    expect(loadTokenSettings({ TOKEN_SIGNING_KEY: base64Pem(crlf) }).signingKeyFingerprint).toBe(
      keyFingerprint(privateKey),
    );
  });
});
