import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from '../../../src/platform/config/secret.js';

const VALUE = 'postgres://pos_app:hunter2@db:5432/pos';

describe('Secret', () => {
  const secret = new Secret(VALUE);

  it('gives the value only through reveal()', () => {
    expect(secret.reveal()).toBe(VALUE);
  });

  it('masks the value in strings, JSON and inspect', () => {
    expect(String(secret)).toBe(REDACTED);
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the leak path under test
    expect(`${secret}`).toBe(REDACTED);
    expect(JSON.stringify({ url: secret })).toBe(`{"url":"${REDACTED}"}`);
    expect(inspect({ url: secret })).toBe(`{ url: ${REDACTED} }`);
  });

  it('keeps the value out of spread, keys and structuredClone', () => {
    expect(Object.keys(secret)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- the leak path under test
    expect(JSON.stringify({ ...secret })).toBe('{}');
    expect(JSON.stringify(structuredClone(secret))).not.toContain('hunter2');
  });
});
