import { setImmediate as nextTick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/platform/logger/logger.js';
import {
  currentRequestContext,
  logger,
  runInRequestContext,
  setRootLogger,
  type RequestContext,
} from '../../../src/platform/logger/request-context.js';

function capturingLogger() {
  const lines: string[] = [];
  const log = createLogger({ logLevel: 'info' }, { write: (line) => lines.push(line) });
  return { log, lines };
}

describe('request context', () => {
  it('outside a request, logger() is the root logger', () => {
    const root = capturingLogger();
    setRootLogger(root.log);
    expect(currentRequestContext()).toBeUndefined();
    logger().info('startup');
    expect(root.lines).toHaveLength(1);
  });

  it('inside a request, logger() carries the request fields across awaits', async () => {
    const root = capturingLogger();
    const context: RequestContext = {
      requestId: 'req-1',
      logger: root.log.child({ requestId: 'req-1' }),
      signal: new AbortController().signal,
    };
    await runInRequestContext(context, async () => {
      await nextTick();
      logger().info('inside');
    });
    expect(JSON.parse(root.lines[0] ?? '{}')).toMatchObject({ requestId: 'req-1', msg: 'inside' });
  });

  it('keeps one mutable context, so later middleware can add the route', async () => {
    const context: RequestContext = {
      requestId: 'req-2',
      logger: capturingLogger().log,
      signal: new AbortController().signal,
    };
    await runInRequestContext(context, async () => {
      await nextTick();
      const current = currentRequestContext();
      if (current !== undefined) current.route = '/api/v1/outlets/:outletId/sales';
    });
    expect(context.route).toBe('/api/v1/outlets/:outletId/sales');
  });

  it('keeps concurrent requests apart', async () => {
    const seen = await Promise.all(
      ['a', 'b'].map((requestId) =>
        runInRequestContext(
          { requestId, logger: capturingLogger().log, signal: new AbortController().signal },
          async () => {
            await nextTick();
            return currentRequestContext()?.requestId;
          },
        ),
      ),
    );
    expect(seen).toEqual(['a', 'b']);
  });
});
