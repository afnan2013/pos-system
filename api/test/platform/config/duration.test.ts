import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../../../src/platform/config/duration.js';

describe('parseDuration', () => {
  it.each([
    ['250ms', 250],
    ['10s', 10_000],
    ['5m', 300_000],
    ['24h', 86_400_000],
    ['0s', 0],
  ])('reads %s as %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', '10', 's', '1.5s', '-1s', '10 s', '1d', '10S', '1h30m', '9999999999s'])(
    'rejects %j',
    (text) => {
      expect(parseDuration(text)).toBeUndefined();
    },
  );
});

describe('formatDuration', () => {
  it.each([
    [86_400_000, '24h'],
    [90_000, '90s'],
    [300_000, '5m'],
    [1500, '1500ms'],
  ])('writes %d ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
