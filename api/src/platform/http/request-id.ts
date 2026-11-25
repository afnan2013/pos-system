import type { RequestHandler } from 'express';
import { uuidV7Ids } from '../ids.js';
import { logger, runInRequestContext, type RequestContext } from '../logger/request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id =
    incoming !== undefined && VALID_REQUEST_ID.test(incoming) ? incoming : uuidV7Ids.next();
  res.set(REQUEST_ID_HEADER, id);

  const abortController = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abortController.abort();
  });

  const context: RequestContext = {
    requestId: id,
    logger: logger().child({ requestId: id }),
    signal: abortController.signal,
  };
  runInRequestContext(context, next);
};
