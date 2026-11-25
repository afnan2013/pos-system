import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { registerHealthRoutes } from './platform/health/health.js';
import { errorHandler } from './platform/http/error-handler.js';
import { jsonBody } from './platform/http/json-body.js';
import { notFoundHandler } from './platform/http/not-found-handler.js';
import { requestId } from './platform/http/request-id.js';
import { requestLog } from './platform/http/request-log.js';
import { recordRoutePrefix } from './platform/http/route-pattern.js';
import { securityHeaders } from './platform/http/security-headers.js';
import { serveWeb } from './platform/http/serve-web.js';
import { mountRoutes } from './routes.js';
import type { Services } from './services.js';

// The web build sits in public/ beside dist/ in the image, and beside src/ in a local build.
export const WEB_BUILD_DIR = fileURLToPath(new URL('../public', import.meta.url));

export type AppOptions = {
  readonly webDir?: string;
};

export function buildApp(services: Services, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(securityHeaders);
  app.use(requestLog);
  app.use(jsonBody);
  registerHealthRoutes(app, services.pool);
  app.use('/api/v1', recordRoutePrefix, mountRoutes());
  app.use('/api', notFoundHandler);
  serveWeb(app, options.webDir ?? WEB_BUILD_DIR);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
