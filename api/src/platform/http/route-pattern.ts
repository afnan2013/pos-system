import type { Request, RequestHandler } from 'express';
import { currentRequestContext } from '../logger/request-context.js';

export const UNMATCHED_ROUTE = 'unmatched';
export const STATIC_ROUTE = 'static';

const routePrefixes = new WeakMap<Request, string>();

// Express restores req.baseUrl when a request leaves a router, so the mount path is kept here.
export const recordRoutePrefix: RequestHandler = (req, _res, next) => {
  routePrefixes.set(req, req.baseUrl);
  next();
};

export function markStaticRoute(): void {
  const context = currentRequestContext();
  if (context !== undefined) context.route = STATIC_ROUTE;
}

export function routeOf(req: Request): string | undefined {
  const recorded = currentRequestContext()?.route;
  if (recorded !== undefined) return recorded;
  const path = matchedPath(req);
  return path === undefined ? undefined : `${routePrefixes.get(req) ?? ''}${path}`;
}

export function allowedMethods(req: Request): string[] {
  const route: unknown = req.route;
  if (!isObject(route) || !isObject(route['methods'])) return [];
  const methods = Object.entries(route['methods'])
    .filter(([method, enabled]) => enabled === true && method !== '_all')
    .map(([method]) => method.toUpperCase());
  if (methods.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
  return methods;
}

function matchedPath(req: Request): string | undefined {
  const route: unknown = req.route;
  return isObject(route) && typeof route['path'] === 'string' ? route['path'] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
