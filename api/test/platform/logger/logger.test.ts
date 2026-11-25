import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from '../../../src/platform/config/secret.js';
import { createLogger } from '../../../src/platform/logger/logger.js';

function capture(logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const log = createLogger({ logLevel }, { write: (line) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, records };
}

describe('createLogger', () => {
  it('writes one JSON line with a level word, an ISO time and the message', () => {
    const { log, records } = capture();
    log.info({ saleId: 'abc' }, 'sale created');
    const [record] = records();
    expect(record).toEqual({
      level: 'info',
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      saleId: 'abc',
      msg: 'sale created',
    });
  });

  it('drops lines below LOG_LEVEL', () => {
    const { log, records } = capture('warn');
    log.info('hidden');
    log.warn('shown');
    expect(records().map((record) => record['msg'])).toEqual(['shown']);
  });

  it('masks a Secret anywhere in a log line', () => {
    const { log, records } = capture();
    const url = new Secret('postgres://pos_app:hunter2@db:5432/pos');
    log.info({ settings: { database: { url } } }, 'config loaded');
    const line = JSON.stringify(records()[0]);
    expect(line).not.toContain('hunter2');
    expect(line).toContain(`"url":"${REDACTED}"`);
  });

  it('blanks sensitive keys at any depth', () => {
    const { log, records } = capture();
    log.info(
      {
        password: 'p0',
        user: { passwordHash: 'p1' },
        req: { headers: { authorization: 'Bearer t', cookie: 'pos_at=t' } },
        a: { b: { c: { d: { e: { token: 'deep' } } } } },
      },
      'oops',
    );
    const line = JSON.stringify(records()[0]);
    for (const leaked of ['p0', 'p1', 'Bearer t', 'pos_at=t', 'deep']) {
      expect(line).not.toContain(leaked);
    }
  });
});
