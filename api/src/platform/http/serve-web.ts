import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import { logger } from '../logger/request-context.js';
import { markStaticRoute } from './route-pattern.js';

export const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'no-cache';

const ASSETS_PATH = '/assets/';

export function serveWeb(app: Express, webDir: string): void {
  const indexFile = path.join(webDir, 'index.html');
  if (!existsSync(indexFile)) {
    logger().info({ webDir }, 'web build not found, serving the API only');
    return;
  }
  const assetsDir = path.join(webDir, 'assets') + path.sep;
  app.use(
    express.static(webDir, {
      index: false,
      redirect: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        markStaticRoute();
        res.setHeader(
          'Cache-Control',
          filePath.startsWith(assetsDir) ? HASHED_ASSET_CACHE : REVALIDATE_CACHE,
        );
      },
    }),
  );
  app.use(spaFallback(indexFile));
}

// A missing hashed asset stays a 404, so an old page never receives HTML in place of a script.
function spaFallback(indexFile: string): RequestHandler {
  return (req, res, next) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead || req.path.startsWith(ASSETS_PATH) || req.accepts('html') === false) {
      next();
      return;
    }
    markStaticRoute();
    res.sendFile(indexFile, {
      cacheControl: false,
      headers: { 'Cache-Control': REVALIDATE_CACHE },
    });
  };
}
