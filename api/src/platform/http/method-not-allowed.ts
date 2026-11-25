import type { RequestHandler } from 'express';
import { allowedMethods } from './route-pattern.js';

export class MethodNotAllowedError extends Error {
  readonly allowed: readonly string[];

  constructor(allowed: readonly string[]) {
    super('Method not allowed');
    this.name = 'MethodNotAllowedError';
    this.allowed = allowed;
  }
}

export const methodNotAllowed: RequestHandler = (req) => {
  throw new MethodNotAllowedError(allowedMethods(req));
};
