import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/platform/clock.js';
import { uuidV7Ids } from '../../src/platform/ids.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV7Ids', () => {
  it('makes distinct UUIDv7 strings in time order', () => {
    const ids = Array.from({ length: 1000 }, () => uuidV7Ids.next());
    for (const id of ids) expect(id).toMatch(UUID_V7);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('systemClock', () => {
  it('reads the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
