import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';
import {
  resolvePostgresConfig,
  type PostgresConfig,
} from './config';
import { createPostgresPool } from './connection';
import { runPostgresMigrations } from './migrations';

export type PostgresDatabase = NodePgDatabase<typeof schema>;
export type PostgresTransaction = Parameters<
  Parameters<PostgresDatabase['transaction']>[0]
>[0];

export interface PostgresRuntimeOptions {
  config?: PostgresConfig;
  initializeSchema?: boolean;
  migrationsFolder?: string;
  createPool?: (config: PostgresConfig) => Pool;
}

export interface PostgresContext {
  db: PostgresDatabase;
  pool: Pool;
}

export class PostgresPersistenceBackend {
  private contextValue: PostgresContext | null = null;
  private initializePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  readonly transactions = {
    run: async <T>(
      work: (context: PostgresTransaction) => Promise<T>,
      options: { access: 'read' | 'write' },
    ): Promise<T> => this.context.db.transaction(
      work,
      { accessMode: options.access === 'read' ? 'read only' : 'read write' },
    ),
  };

  constructor(private readonly options: PostgresRuntimeOptions = {}) {}

  get context(): PostgresContext {
    if (!this.contextValue) {
      throw new Error('PostgreSQL persistence has not been initialized');
    }
    return this.contextValue;
  }

  initialize(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise.then(() => this.initialize());
    }
    if (this.contextValue) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.initializeOnce().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    const config = this.options.config ?? resolvePostgresConfig();
    const pool = (this.options.createPool ?? createPostgresPool)(config);
    try {
      await pool.query('SELECT 1');
      if (this.options.initializeSchema !== false) {
        await runPostgresMigrations(pool, {
          migrationsFolder: this.options.migrationsFolder,
        });
      }
      this.contextValue = {
        pool,
        db: drizzle(pool, { schema }),
      };
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownOnce().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise.catch(() => undefined);
    }
    const context = this.contextValue;
    this.contextValue = null;
    if (context) await context.pool.end();
  }
}
