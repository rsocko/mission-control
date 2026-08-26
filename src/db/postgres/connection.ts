import pg from 'pg';
import { dbLogger } from '@/lib/logger';
import type { PostgresConfig } from './config';

const { Pool } = pg;

export function createPostgresPool(config: PostgresConfig): pg.Pool {
  const pool = new Pool(config.pool);
  pool.on('error', (error) => {
    dbLogger.error({ err: error }, 'Idle PostgreSQL pool client failed');
  });
  return pool;
}

