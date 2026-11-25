import { AsyncLocalStorage } from 'node:async_hooks';
import { LogLevel } from '../config/base.js';
import { createLogger, type Logger } from './logger.js';

export type RequestContext = {
  readonly requestId: string;
  logger: Logger;
  readonly signal: AbortSignal;
  route?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

let rootLogger: Logger = createLogger({ logLevel: LogLevel.Info });

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export function runInRequestContext<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function logger(): Logger {
  return storage.getStore()?.logger ?? rootLogger;
}
