import type { ErrorRequestHandler, Request, Response } from 'express';
import { databaseErrorLog, loggableError } from '../db/loggable-error.js';
import type { AppError, FieldErrors } from '../errors/app-error.js';
import { ErrorKind, problemSpecs, type ProblemSpec } from '../errors/error-kind.js';
import { causeChain, kindOf } from '../errors/kind-of.js';
import { toAppError } from '../errors/to-app-error.js';
import { currentRequestContext, logger } from '../logger/request-context.js';
import { MethodNotAllowedError } from './method-not-allowed.js';
import { REQUEST_ID_HEADER } from './request-id.js';
import { routeOf } from './route-pattern.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type Problem = {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly fields?: FieldErrors;
};

const METHOD_NOT_ALLOWED: Problem = {
  status: 405,
  slug: 'method-not-allowed',
  title: 'Method not allowed',
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof MethodNotAllowedError) {
    if (res.headersSent) {
      abandonResponse(req, err);
      return;
    }
    res.set('Allow', err.allowed.join(', '));
    writeProblem(req, res, METHOD_NOT_ALLOWED);
    return;
  }

  const appError = toAppError(err);
  const kind = kindOf(appError);
  const spec = problemSpecs[kind];
  if (res.headersSent) {
    abandonResponse(req, appError);
    return;
  }
  logProblem(req, appError, kind, spec);
  writeProblem(req, res, problemOf(appError, kind, spec));
};

export function writeProblem(req: Request, res: Response, problem: Problem): void {
  const body = {
    type: `/problems/${problem.slug}`,
    title: problem.title,
    status: problem.status,
    instance: pathOf(req),
    requestId: currentRequestContext()?.requestId ?? res.get(REQUEST_ID_HEADER),
    ...(problem.fields === undefined ? {} : { errors: problem.fields }),
  };
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).set('Cache-Control', 'no-store').json(body);
}

function problemOf(appError: AppError, kind: ErrorKind, spec: ProblemSpec): Problem {
  // A wrapped abort or timeout reports its real kind, so the wrapper's title does not apply.
  const title =
    appError.kind === kind && kind !== ErrorKind.Unexpected ? appError.title : spec.title;
  const fields = kind === ErrorKind.Validation ? appError.fields : undefined;
  return {
    status: spec.status,
    slug: spec.slug,
    title,
    ...(fields === undefined ? {} : { fields }),
  };
}

function logProblem(req: Request, appError: AppError, kind: ErrorKind, spec: ProblemSpec): void {
  const route = routeOf(req);
  const log = logger();
  switch (spec.logAt) {
    case 'error':
      log.error({ err: loggableError(appError), route }, 'unexpected error');
      return;
    case 'warn':
      log.warn({ kind, reason: reasonOf(appError), route }, spec.title);
      return;
    case 'info':
      log.info({ kind, route }, spec.title);
      return;
    case 'none':
      if (kind === ErrorKind.Validation) logDatabaseRejection(appError, route);
  }
}

function logDatabaseRejection(appError: AppError, route: string | undefined): void {
  const database = databaseErrorLog(appError);
  if (database === undefined) return;
  logger().info({ ...database, route }, 'database rejected the input');
}

function abandonResponse(req: Request, err: unknown): void {
  logger().error({ err: loggableError(err), route: routeOf(req) }, 'error after response started');
  req.socket.destroy();
}

function reasonOf(appError: AppError): string[] {
  return causeChain(appError.cause)
    .filter((link): link is Error => link instanceof Error)
    .map((link) => {
      const code = 'code' in link && typeof link.code === 'string' ? ` (${link.code})` : '';
      return `${link.name}${code}: ${link.message}`;
    });
}

function pathOf(req: Request): string {
  const url = req.originalUrl;
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}
