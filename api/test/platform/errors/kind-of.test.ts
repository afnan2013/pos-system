import { describe, expect, it } from 'vitest';
import {
  AppError,
  conflict,
  ErrNotFound,
  unavailable,
  unexpected,
  validation,
} from '../../../src/platform/errors/app-error.js';
import { causeChain, isError, kindOf, withTitle } from '../../../src/platform/errors/kind-of.js';

const ErrInsufficientStock = conflict('Not enough stock');

function abortError(): unknown {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason;
}

function timeoutError(): unknown {
  return new DOMException('The operation timed out', 'TimeoutError');
}

describe('kindOf', () => {
  it('takes the kind of the error itself', () => {
    expect(kindOf(ErrNotFound)).toBe('not_found');
  });

  it('walks the cause chain to the first AppError', () => {
    const wrapped = new Error('repository failed', {
      cause: new Error('x', { cause: ErrNotFound }),
    });
    expect(kindOf(wrapped)).toBe('not_found');
  });

  it('stops at the first AppError, even if a deeper one has another kind', () => {
    const outer = new AppError('conflict', 'outer', { cause: validation({ a: 'b' }) });
    expect(kindOf(outer)).toBe('conflict');
  });

  it('reports an abort as canceled, even wrapped in unexpected', () => {
    expect(kindOf(abortError())).toBe('canceled');
    expect(kindOf(unexpected(abortError()))).toBe('canceled');
  });

  it('reports a timeout as unavailable, even wrapped in unexpected', () => {
    expect(kindOf(timeoutError())).toBe('unavailable');
    expect(kindOf(unexpected(new Error('query failed', { cause: timeoutError() })))).toBe(
      'unavailable',
    );
  });

  it('prefers an AppError kind over an abort deeper in the chain', () => {
    expect(kindOf(unavailable('Database unavailable', abortError()))).toBe('unavailable');
  });

  it('prefers an abort over a timeout wherever each sits in the chain', () => {
    const timeoutOutside = new DOMException('timed out', 'TimeoutError');
    Object.assign(timeoutOutside, { cause: abortError() });
    expect(kindOf(timeoutOutside)).toBe('canceled');
  });

  it.each([new Error('boom'), 'a string', null, undefined, { code: '42501' }])(
    'reports %o as unexpected',
    (value) => {
      expect(kindOf(value)).toBe('unexpected');
    },
  );

  it('survives a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(kindOf(a)).toBe('unexpected');
    expect(causeChain(a)).toEqual([a, b]);
  });
});

describe('isError and withTitle', () => {
  it('matches by identity through the cause chain', () => {
    const named = withTitle(ErrInsufficientStock, 'Not enough stock for Iced Latte');
    expect(named.title).toBe('Not enough stock for Iced Latte');
    expect(named.kind).toBe('conflict');
    expect(named.cause).toBe(ErrInsufficientStock);
    expect(isError(named, ErrInsufficientStock)).toBe(true);
    expect(isError(new Error('tx failed', { cause: named }), ErrInsufficientStock)).toBe(true);
  });

  it('does not match a different error of the same kind', () => {
    expect(isError(conflict('Not enough stock'), ErrInsufficientStock)).toBe(false);
    expect(isError(undefined, ErrInsufficientStock)).toBe(false);
  });

  it('keeps validation fields', () => {
    const base = validation({ name: 'is required' });
    expect(withTitle(base, 'Check the form').fields).toEqual({ name: 'is required' });
  });
});
