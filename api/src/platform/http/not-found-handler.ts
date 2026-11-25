import type { RequestHandler } from 'express';
import { ErrNotFound } from '../errors/app-error.js';

export const notFoundHandler: RequestHandler = () => {
  throw ErrNotFound;
};
