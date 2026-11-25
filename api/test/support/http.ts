import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { Secret } from '../../src/platform/config/secret.js';
import { createPool } from '../../src/platform/db/create-pool.js';
import { errorHandler } from '../../src/platform/http/error-handler.js';
import { jsonBody } from '../../src/platform/http/json-body.js';
import { notFound } from '../../src/platform/http/not-found.js';
import { requestId } from '../../src/platform/http/request-id.js';
import { requestLog } from '../../src/platform/http/request-log.js';
import { securityHeaders } from '../../src/platform/http/security-headers.js';

export function platformApp(register: (app: Express) => void): Express {
  const app = express();
  app.use(requestId);
  app.use(securityHeaders);
  app.use(requestLog);
  app.use(jsonBody);
  register(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// Port 1 refuses connections, so any query on this pool fails fast with ECONNREFUSED.
export function unreachablePool(): Pool {
  return createPool({ url: new Secret('postgres://nobody:nothing@127.0.0.1:1/pos'), maxConns: 1 });
}
