import { z } from 'zod';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
const DURATION = /^(\d{1,9})(ms|s|m|h)$/;

export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (match === null) return undefined;
  const [, amount, unit] = match;
  if (amount === undefined || unit === undefined) return undefined;
  return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
}

export function formatDuration(ms: number): string {
  for (const unit of ['h', 'm', 's'] as const) {
    if (ms % UNIT_MS[unit] === 0) return `${String(ms / UNIT_MS[unit])}${unit}`;
  }
  return `${String(ms)}ms`;
}

export function duration(options: { fallback: string; maxMs?: number }) {
  const limit = options.maxMs === undefined ? '' : `, at most ${formatDuration(options.maxMs)}`;
  const message = `must be a duration such as 500ms, 10s, 5m or 1h${limit}`;
  return z
    .string()
    .default(options.fallback)
    .transform((text, ctx) => {
      const ms = parseDuration(text);
      if (ms !== undefined && ms > 0 && (options.maxMs === undefined || ms <= options.maxMs)) {
        return ms;
      }
      ctx.addIssue(message);
      return z.NEVER;
    });
}
