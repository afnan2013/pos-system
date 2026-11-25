import { pino, stdTimeFunctions, type DestinationStream, type Logger } from 'pino';
import type { BaseSettings } from '../config/base.js';
import { REDACTED } from '../config/secret.js';

export type { Logger } from 'pino';

const REDACTED_KEYS = ['password', 'passwordHash', 'token', 'authorization', 'cookie'];
// pino's wildcard matches one level, so the paths are spelled out to this depth.
const REDACT_DEPTH = 5;

export const REDACT_PATHS = Array.from({ length: REDACT_DEPTH + 1 }, (_, depth) =>
  REDACTED_KEYS.map((key) => `${'*.'.repeat(depth)}${key}`),
).flat();

export function createLogger(
  settings: Pick<BaseSettings, 'logLevel'>,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: settings.logLevel,
    base: null,
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
