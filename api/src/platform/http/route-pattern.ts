import type { Request, RequestHandler } from 'express';
import { hasProperty } from '../has-property.js';
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
  const enabled: unknown = hasProperty(route, 'methods') ? route.methods : undefined;
  if (typeof enabled !== 'object' || enabled === null) return [];
  const methods = Object.keys(enabled)
    .filter(
      (method) => method !== '_all' && hasProperty(enabled, method) && enabled[method] === true,
    )
    .map((method) => method.toUpperCase());
  if (methods.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
  return methods;
}

function matchedPath(req: Request): string | undefined {
  const route: unknown = req.route;
  return hasProperty(route, 'path') && typeof route.path === 'string' ? route.path : undefined;
}
