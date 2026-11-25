import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { int8AsNumber, parseInt8 } from '../../../src/platform/db/int8.js';

describe('parseInt8', () => {
  it('parses safe integers', () => {
    expect(parseInt8('0')).toBe(0);
    expect(parseInt8('-42')).toBe(-42);
    expect(parseInt8(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInt8(String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('refuses values beyond the safe integer range', () => {
    expect(() => parseInt8('9007199254740992')).toThrow(RangeError);
    expect(() => parseInt8('-9007199254740992')).toThrow(RangeError);
    expect(() => parseInt8('9223372036854775807')).toThrow(RangeError);
  });
});

describe('int8AsNumber', () => {
  it('uses parseInt8 for int8 text values', () => {
    expect(int8AsNumber.getTypeParser(pg.types.builtins.INT8, 'text')).toBe(parseInt8);
    expect(int8AsNumber.getTypeParser(pg.types.builtins.INT8)).toBe(parseInt8);
  });

  it('leaves every other type to pg', () => {
    expect(int8AsNumber.getTypeParser(pg.types.builtins.NUMERIC, 'text')).toBe(
      pg.types.getTypeParser(pg.types.builtins.NUMERIC, 'text'),
    );
  });
});
