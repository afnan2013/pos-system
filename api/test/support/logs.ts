import { createLogger } from '../../src/platform/logger/logger.js';
import { setRootLogger } from '../../src/platform/logger/request-context.js';

export type LogRecord = Record<string, unknown>;

export function silenceLogs(): void {
  setRootLogger(createLogger({ logLevel: 'error' }, { write: () => undefined }));
}

export function captureLogs(): { records: () => LogRecord[] } {
  const lines: string[] = [];
  setRootLogger(
    createLogger(
      { logLevel: 'debug' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    ),
  );
  return { records: () => lines.map((line) => JSON.parse(line) as LogRecord) };
}
