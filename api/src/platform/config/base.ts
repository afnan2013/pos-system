import { z } from 'zod';
import { ConfigError } from './config-error.js';
import { parseEnv, type Env } from './env.js';

export const AppEnv = { Local: 'local', Prod: 'prod' } as const;
export type AppEnv = (typeof AppEnv)[keyof typeof AppEnv];

export const LogLevel = { Debug: 'debug', Info: 'info', Warn: 'warn', Error: 'error' } as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export type BaseSettings = {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
};

export function loadBase(env: Env): BaseSettings {
  const settings = parseEnv(env, {
    appEnv: {
      name: 'APP_ENV',
      schema: z.enum(AppEnv, { error: 'required (local or prod)' }),
    },
    logLevel: {
      name: 'LOG_LEVEL',
      schema: z
        .enum(LogLevel, { error: 'must be debug, info, warn or error' })
        .default(LogLevel.Info),
    },
  });
  if (settings.appEnv === AppEnv.Prod && settings.logLevel === LogLevel.Debug) {
    throw new ConfigError(['LOG_LEVEL: debug is for local use only; use info, warn or error']);
  }
  return settings;
}
