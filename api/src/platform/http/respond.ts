import type { Response } from 'express';

export function respond(res: Response, status: 204): void;
export function respond(res: Response, status: number, body: unknown): void;
export function respond(res: Response, status: number, body?: unknown): void {
  res.status(status).set('Cache-Control', 'private, no-store');
  if (body === undefined) {
    res.end();
    return;
  }
  res.json(body);
}
