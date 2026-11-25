import { z } from 'zod';
import { ConfigError } from './config-error.js';

export type Env = Readonly<Record<string, string | undefined>>;

type Setting = { readonly name: string; readonly schema: z.ZodType };

type Parsed<Settings extends Record<string, Setting>> = {
  [Key in keyof Settings]: z.output<Settings[Key]['schema']>;
};

export function parseEnv<const Settings extends Record<string, Setting>>(
  env: Env,
  settings: Settings,
): Parsed<Settings> {
  const shape: Record<string, z.ZodType> = {};
  const input: Record<string, string | undefined> = {};
  for (const [key, setting] of Object.entries(settings)) {
    shape[key] = setting.schema;
    input[key] = readSetting(env, setting.name);
  }
  const parsed = z.object(shape).safeParse(input);
  if (!parsed.success) throw new ConfigError(problemsOf(parsed.error, settings));
  return parsed.data as Parsed<Settings>;
}

export function wholeNumber(min: number, max: number, fallback: number) {
  const message = `must be a whole number from ${String(min)} to ${String(max)}`;
  return z
    .string()
    .default(String(fallback))
    .transform((text, ctx) => {
      const value = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
      if (value >= min && value <= max) return value;
      ctx.addIssue(message);
      return z.NEVER;
    });
}

// Compose substitutes an unset variable as an empty string; treat it as unset so defaults apply.
function readSetting(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function problemsOf(error: z.ZodError, settings: Record<string, Setting>): string[] {
  const problems = new Map<string, string>();
  for (const issue of error.issues) {
    const key = issue.path[0];
    const name = typeof key === 'string' ? (settings[key]?.name ?? key) : 'settings';
    if (!problems.has(name)) problems.set(name, `${name}: ${issue.message}`);
  }
  return [...problems.values()];
}
