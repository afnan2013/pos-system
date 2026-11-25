import { AsyncResource } from 'node:async_hooks';
import express, { type RequestHandler } from 'express';

export const JSON_BODY_LIMIT = '1mb';

const parseJson: RequestHandler = express.json({ limit: JSON_BODY_LIMIT, strict: true });

// The parser resumes from a stream event outside the request's async context; binding next restores it.
export const jsonBody: RequestHandler = (req, res, next) => {
  parseJson(req, res, AsyncResource.bind(next));
};
