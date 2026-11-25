import { describe, expect, it } from 'vitest';
import { hasProperty } from '../../src/platform/has-property.js';

describe('hasProperty', () => {
  it('is true for an object that has the key, even when its value is undefined', () => {
    expect(hasProperty({ code: '23505' }, 'code')).toBe(true);
    expect(hasProperty({ code: undefined }, 'code')).toBe(true);
  });

  it('sees keys an object inherits, such as an error name', () => {
    expect(hasProperty(new TypeError('boom'), 'name')).toBe(true);
  });

  it('is false for an object without the key', () => {
    expect(hasProperty({ other: 1 }, 'code')).toBe(false);
  });

  it.each([null, undefined, 'code', 42, true])('is false for %s', (value) => {
    expect(hasProperty(value, 'code')).toBe(false);
  });
});
