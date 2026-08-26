import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import type { DatabaseBootstrapAdapter } from '@/db/bootstrap/contracts';

const MIGRATION_LOCK_NAMESPACE = 1_296_250_820;
const MIGRATION_LOCK_ID = 1_619;

export interface PostgresMigrationOptions {
  migrationsFolder?: string;
}

export class PostgresDatabaseBootstrapAdapter implements DatabaseBootstrapAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresMigrationOptions = {},
  ) {}

  initialize(): Promise<void> {
    return runPostgresMigrations(this.pool, this.options);
  }
}

export async function runPostgresMigrations(
  pool: Pool,
  options: PostgresMigrationOptions = {},
): Promise<void> {
  const client = await pool.connect();
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET idle_in_transaction_session_timeout = 0');
    await client.query(
      'SELECT pg_advisory_lock($1, $2)',
      [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID],
    );
    try {
      await migrate(drizzle(client), {
        migrationsFolder:
          options.migrationsFolder
          ?? path.join(process.cwd(), 'drizzle', 'postgres'),
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations',
      });
    } finally {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID],
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await client.query('RESET statement_timeout');
      await client.query('RESET idle_in_transaction_session_timeout');
    } catch (error) {
      cleanupError = error;
    }
    client.release(cleanupError instanceof Error ? cleanupError : undefined);
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'PostgreSQL migration and connection cleanup failed',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}
