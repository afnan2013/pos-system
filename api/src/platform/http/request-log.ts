import { performance } from 'node:perf_hooks';
import type { RequestHandler, Response } from 'express';
import { currentRequestContext, logger } from '../logger/request-context.js';
import { routeOf, UNMATCHED_ROUTE } from './route-pattern.js';

export const requestLog: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  const context = currentRequestContext();
  let written = false;

  const write = (aborted: boolean) => {
    if (written) return;
    written = true;
    const requestLogger = context?.logger ?? logger();
    requestLogger.info(
      {
        method: req.method,
        route: routeOf(req) ?? UNMATCHED_ROUTE,
        status: res.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        bytes: bodyBytes(res),
        ...(aborted ? { aborted: true } : {}),
      },
      'request',
    );
  };

  res.once('finish', () => {
    write(false);
  });
  res.once('close', () => {
    write(!res.writableFinished);
  });
  next();
};

function bodyBytes(res: Response): number {
  const length = Number(res.getHeader('Content-Length'));
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}
