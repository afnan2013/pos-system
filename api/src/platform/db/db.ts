import type { Pool, PoolClient } from 'pg';

declare const txBrand: unique symbol;

export type Tx = PoolClient & { readonly [txBrand]: true };

export type Db = Pool | Tx;
