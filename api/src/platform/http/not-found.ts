import type { RequestHandler } from 'express';
import { ErrNotFound } from '../errors/app-error.js';

export const notFound: RequestHandler = () => {
  throw ErrNotFound;
};
