import { hasProperty } from '../has-property.js';
import { AppError, ErrorKind } from './app-error.js';

const MAX_CAUSE_DEPTH = 32;

export function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = err;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return chain;
}

export function kindOf(err: unknown): ErrorKind {
  const chain = causeChain(err);
  const firstAppError = chain.find((link) => link instanceof AppError);
  if (firstAppError !== undefined && firstAppError.kind !== ErrorKind.Unexpected) {
    return firstAppError.kind;
  }
  if (chain.some((link) => hasName(link, 'AbortError'))) return ErrorKind.Canceled;
  if (chain.some((link) => hasName(link, 'TimeoutError'))) return ErrorKind.Unavailable;
  return ErrorKind.Unexpected;
}

export function isError(err: unknown, target: AppError): boolean {
  return causeChain(err).includes(target);
}

export function withTitle(target: AppError, title: string): AppError {
  return new AppError(
    target.kind,
    title,
    target.fields === undefined ? { cause: target } : { fields: target.fields, cause: target },
  );
}

function hasName(link: unknown, name: string): boolean {
  return hasProperty(link, 'name') && link.name === name;
}
