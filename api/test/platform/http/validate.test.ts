import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/platform/errors/app-error.js';
import { fieldName, UNKNOWN_FIELD_MESSAGE, validate } from '../../../src/platform/http/validate.js';

const createSale = z
  .object({
    items: z
      .array(z.object({ menuItemId: z.uuid(), quantity: z.number().int().min(1) }).strict())
      .min(1),
  })
  .strict();

function fieldsOf(run: () => unknown): Readonly<Record<string, string>> | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError && error.kind === 'validation') return error.fields;
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('validate', () => {
  it('returns the parsed value', () => {
    const body = { items: [{ menuItemId: '0193b6f0-2a4c-7c1e-9d2b-5f0a1e3c4d5e', quantity: 2 }] };
    expect(validate(createSale, body)).toEqual(body);
  });

  it('keys errors by the JSON field names', () => {
    const fields = fieldsOf(() =>
      validate(createSale, {
        items: [
          { menuItemId: '0193b6f0-2a4c-7c1e-9d2b-5f0a1e3c4d5e', quantity: 1 },
          { menuItemId: 'nope', quantity: 0 },
        ],
      }),
    );
    expect(Object.keys(fields ?? {})).toEqual(['items[1].menuItemId', 'items[1].quantity']);
  });

  it('names each unknown field', () => {
    expect(fieldsOf(() => validate(createSale, { items: [], extra: 1 }))).toMatchObject({
      extra: UNKNOWN_FIELD_MESSAGE,
    });
  });

  it('keys an error about the whole value by its root', () => {
    expect(Object.keys(fieldsOf(() => validate(createSale, 'text')) ?? {})).toEqual(['body']);
    expect(Object.keys(fieldsOf(() => validate(z.uuid(), 'x', 'Idempotency-Key')) ?? {})).toEqual([
      'Idempotency-Key',
    ]);
  });

  it('formats paths', () => {
    expect(fieldName(['items', 0, 'quantity'], 'body')).toBe('items[0].quantity');
    expect(fieldName([], 'query')).toBe('query');
  });
});
