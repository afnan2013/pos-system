import type { Pool } from 'pg';

export type Services = {
  readonly pool: Pool;
};

export function buildServices(pool: Pool): Services {
  return { pool };
}
