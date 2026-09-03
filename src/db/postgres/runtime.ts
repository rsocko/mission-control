import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type {
  PersistenceBackend,
  SynchronousTransactionResult,
  SynchronousTransactionRunner,
  TransactionOptions,
  TransactionRunner,
} from '@/db/persistence/contracts';
import * as schema from './schema';
import {
  resolvePostgresConfig,
  type PostgresConfig,
} from './config';
import { createPostgresPool } from './connection';
import { runPostgresMigrations } from './migrations';
import {
  disabledPostgresVectorCapability,
  initializePostgresVectorSupport,
  PostgresVectorUnavailableError,
  resolvePostgresVectorMode,
  type PostgresVectorCapability,
  type PostgresVectorMode,
} from './vector-support';

export type PostgresDatabase = NodePgDatabase<typeof schema>;
export type PostgresTransaction = Parameters<
  Parameters<PostgresDatabase['transaction']>[0]
>[0];

export interface PostgresRuntimeOptions {
  config?: PostgresConfig;
  initializeSchema?: boolean;
  migrationsFolder?: string;
  vectorMigrationsFolder?: string;
  vectorMode?: PostgresVectorMode;
  createPool?: (config: PostgresConfig) => Pool;
}

export interface PostgresContext {
  db: PostgresDatabase;
  pool: Pool;
  vector: PostgresVectorCapability;
}

export class PostgresPersistenceBackend
implements PersistenceBackend<PostgresTransaction> {
  private contextValue: PostgresContext | null = null;
  private cleanupPool: Pool | null = null;
  private initializePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  readonly transactions: SynchronousTransactionRunner<PostgresTransaction> = {
    run: <T>(
      work: (context: PostgresTransaction) => SynchronousTransactionResult<T>,
      options: TransactionOptions = {},
    ): Promise<T> => this.context.db.transaction(
      async (context) => work(context),
      { accessMode: options.access === 'read' ? 'read only' : 'read write' },
    ),
  };

  readonly asyncTransactions: TransactionRunner<PostgresTransaction> = {
    run: <T>(
      work: (context: PostgresTransaction) => T | Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> => this.context.db.transaction(
      async (context) => work(context),
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
    if (this.cleanupPool) {
      return this.shutdown().then(() => this.initialize());
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
      const vectorMode = this.options.vectorMode ?? resolvePostgresVectorMode();
      if (this.options.initializeSchema === false && vectorMode === 'required') {
        throw new PostgresVectorUnavailableError(
          'PostgreSQL indexed vector retrieval is required, but schema initialization is disabled.',
        );
      }
      const vector = this.options.initializeSchema === false
        ? disabledPostgresVectorCapability(vectorMode)
        : await initializePostgresVectorSupport(pool, {
            mode: vectorMode,
            migrationsFolder: this.options.vectorMigrationsFolder,
          });
      this.contextValue = {
        pool,
        db: drizzle(pool, { schema }),
        vector,
      };
    } catch (error) {
      try {
        await pool.end();
      } catch (cleanupError) {
        this.cleanupPool = pool;
        throw new AggregateError(
          [error, cleanupError],
          'PostgreSQL initialization failed and pool cleanup is incomplete',
          { cause: error },
        );
      }
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
    const pool = context?.pool ?? this.cleanupPool;
    if (!pool) return;
    try {
      await pool.end();
    } catch (error) {
      this.cleanupPool = pool;
      throw error;
    }
    if (this.contextValue === context) this.contextValue = null;
    if (this.cleanupPool === pool) this.cleanupPool = null;
  }
}
