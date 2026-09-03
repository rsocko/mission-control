import type Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import * as schema from './schema';
import {
  configureDatabaseConnection,
  openDatabaseConnection,
  shouldRunDatabaseInitialization,
} from './bootstrap/connection';
import { runOrderedDatabaseBootstrap } from './bootstrap/registry';
import {
  createObservedDatabase,
  DatabaseTelemetryCollector,
  type DatabaseTelemetrySnapshot,
} from '@/lib/telemetry/database';
import { resolveDatabaseBackend } from './runtime-backend';
import { createSqliteCorePersistenceRepositories } from './persistence/sqlite-core-repositories';
import {
  assertCanRegisterSqliteWorkerRuntimeServices,
  clearSqliteWorkerRuntimeServices,
  createSqliteWorkerPersistenceRepositories,
  registerSqliteWorkerRuntimeServices,
} from './persistence/sqlite-worker-runtime';
import {
  assertCanRegisterCorePersistenceRepositories,
  clearCorePersistenceRepositories,
  registerCorePersistenceRepositories,
} from '@/lib/persistence/runtime';
import {
  assertPersistenceCompositionPublicationAllowed,
  completePersistenceCompositionInitialization,
} from '@/lib/persistence/composition-lifecycle';
import {
  assertCanRegisterWorkerPersistenceRepositories,
  clearWorkerPersistenceRepositories,
  registerWorkerPersistenceRepositories,
} from '@/lib/persistence/worker-runtime';
import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';

// Keep connection creation lazy so Next.js build workers do not race to open
// the database during static analysis.
let _sqlite: Database.Database | null = null;
let _observedSqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;
let sqliteComposition: {
  coreRepositories: CorePersistenceRepositories;
  workerRepositories: WorkerPersistenceRepositories;
} | null = null;
let sqliteCompositionPromise: Promise<void> | null = null;
let sqliteCompositionShutdownPromise: Promise<void> | null = null;
let sqliteCompositionState: 'cold' | 'initializing' | 'active' | 'stopping' | 'stopped' = 'cold';
const databaseTelemetry = new DatabaseTelemetryCollector();

function resetPartialDatabaseInitialization(): void {
  try {
    _sqlite?.close();
  } catch {
    // The original initialization error is more useful than a cleanup error.
  }
  _sqlite = null;
  _observedSqlite = null;
  _db = null;
}

function assertSqliteCompatibilityAccessAllowed(): void {
  if (sqliteCompositionState === 'stopping' || sqliteCompositionState === 'stopped') {
    throw new Error(
      'SQLite compatibility access is blocked after shutdown until initializeRuntimeDatabase() starts a new generation',
    );
  }
  if (sqliteCompositionState === 'initializing') {
    throw new Error('SQLite persistence composition initialization is already in progress');
  }
}

function getOrCreateSqliteComposition(): NonNullable<typeof sqliteComposition> {
  const localSqlite = _observedSqlite;
  const localDb = _db;
  if (!localSqlite || !localDb) {
    throw new Error('SQLite must be initialized before persistence composition');
  }
  if (!sqliteComposition) {
    const coreRepositories = createSqliteCorePersistenceRepositories(localSqlite);
    sqliteComposition = {
      coreRepositories,
      workerRepositories: createSqliteWorkerPersistenceRepositories(
        localSqlite,
        localDb,
        coreRepositories,
      ),
    };
  }
  return sqliteComposition;
}

function publishSqliteComposition(): void {
  const composition = getOrCreateSqliteComposition();

  assertCanRegisterCorePersistenceRepositories(composition.coreRepositories);
  assertCanRegisterWorkerPersistenceRepositories(composition.workerRepositories);
  assertCanRegisterSqliteWorkerRuntimeServices();

  try {
    registerCorePersistenceRepositories(composition.coreRepositories);
    registerWorkerPersistenceRepositories(composition.workerRepositories);
    registerSqliteWorkerRuntimeServices();
    sqliteCompositionState = 'active';
    completePersistenceCompositionInitialization();
  } catch (error) {
    clearSqliteWorkerRuntimeServices();
    clearWorkerPersistenceRepositories(composition.workerRepositories);
    clearCorePersistenceRepositories(composition.coreRepositories);
    throw error;
  }
}

// Temporary L03a1 bridge. L03a2 removes this call from raw SQLite access.
function publishTemporarySqliteCompatibilityComposition(): void {
  assertPersistenceCompositionPublicationAllowed();
  if (sqliteCompositionState === 'active') return;
  assertSqliteCompatibilityAccessAllowed();
  sqliteCompositionState = 'initializing';
  try {
    publishSqliteComposition();
  } catch (error) {
    sqliteCompositionState = 'cold';
    throw error;
  }
}

function initDatabase(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
} {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'This workflow still uses the SQLite compatibility API and is not supported by the PostgreSQL backend',
    );
  }
  assertPersistenceCompositionPublicationAllowed();
  if (_observedSqlite && _db) {
    publishTemporarySqliteCompatibilityComposition();
    return { sqlite: _observedSqlite, db: _db };
  }
  if (_sqlite || _observedSqlite || _db) resetPartialDatabaseInitialization();

  const sqlite = openDatabaseConnection();
  try {
    configureDatabaseConnection(sqlite);
    const observedSqlite = createObservedDatabase(sqlite, databaseTelemetry);
    const localDb = drizzle(observedSqlite, { schema });

    if (shouldRunDatabaseInitialization()) {
      runOrderedDatabaseBootstrap(sqlite, path.join(process.cwd(), 'drizzle'));
    }

    _sqlite = sqlite;
    _observedSqlite = observedSqlite;
    _db = localDb;
    publishTemporarySqliteCompatibilityComposition();
    databaseTelemetry.reset();
    return { sqlite: observedSqlite, db: localDb };
  } catch (error) {
    if (_sqlite !== sqlite) {
      try {
        sqlite.close();
      } catch {
        // Preserve the initialization error when closing a partial handle fails.
      }
    }
    throw error;
  }
}

export function initializeDatabase(): void {
  initDatabase();
}

export function initializeSqlitePersistenceComposition(): Promise<void> {
  if (sqliteCompositionState === 'active') return Promise.resolve();
  if (sqliteCompositionPromise) return sqliteCompositionPromise;
  if (sqliteCompositionState === 'stopping') {
    return Promise.reject(new Error('SQLite persistence composition shutdown is in progress'));
  }

  const retryState = sqliteCompositionState === 'stopped' ? 'stopped' : 'cold';
  sqliteCompositionState = 'initializing';
  const pending = Promise.resolve().then(() => {
    try {
      if (!_observedSqlite || !_db) {
        const sqlite = openDatabaseConnection();
        try {
          configureDatabaseConnection(sqlite);
          const observedSqlite = createObservedDatabase(sqlite, databaseTelemetry);
          const localDb = drizzle(observedSqlite, { schema });
          if (shouldRunDatabaseInitialization()) {
            runOrderedDatabaseBootstrap(sqlite, path.join(process.cwd(), 'drizzle'));
          }
          _sqlite = sqlite;
          _observedSqlite = observedSqlite;
          _db = localDb;
          databaseTelemetry.reset();
        } catch (error) {
          try {
            sqlite.close();
          } catch {
            // Preserve the initialization error when closing a partial handle fails.
          }
          throw error;
        }
      }
      if (sqliteCompositionState !== 'initializing') {
        throw new Error('SQLite persistence composition initialization was invalidated');
      }
      publishSqliteComposition();
    } catch (error) {
      if (sqliteCompositionState !== 'stopping') sqliteCompositionState = retryState;
      throw error;
    }
  });
  let tracked: Promise<void>;
  tracked = pending.finally(() => {
    if (sqliteCompositionPromise === tracked) sqliteCompositionPromise = null;
  });
  sqliteCompositionPromise = tracked;
  return tracked;
}

export function shutdownSqlitePersistenceComposition(): Promise<void> {
  if (sqliteCompositionShutdownPromise) return sqliteCompositionShutdownPromise;
  sqliteCompositionState = 'stopping';

  const pending = (async () => {
    if (sqliteCompositionPromise) {
      await sqliteCompositionPromise.catch(() => undefined);
    }
    if (sqliteComposition) {
      clearSqliteWorkerRuntimeServices();
      clearWorkerPersistenceRepositories(sqliteComposition.workerRepositories);
      clearCorePersistenceRepositories(sqliteComposition.coreRepositories);
    }
    sqliteCompositionState = 'stopped';
  })();
  let tracked: Promise<void>;
  tracked = pending.finally(() => {
    if (sqliteCompositionShutdownPromise === tracked) {
      sqliteCompositionShutdownPromise = null;
    }
  });
  sqliteCompositionShutdownPromise = tracked;
  return tracked;
}

const db: BetterSQLite3Database<typeof schema> = new Proxy(
  {} as BetterSQLite3Database<typeof schema>,
  {
    get(_target, prop, receiver) {
      const { db: realDb } = initDatabase();
      return Reflect.get(realDb, prop, receiver);
    },
  },
);

const sqlite: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const { sqlite: realSqlite } = initDatabase();
    return Reflect.get(realSqlite, prop, receiver);
  },
});

function runTransaction<T>(
  fn: (tx: BetterSQLite3Database<typeof schema>) => T,
  options: { readOnly?: boolean } = {},
): T {
  const { db: realDb } = initDatabase();
  return realDb.transaction(fn, {
    behavior: options.readOnly ? 'deferred' : 'immediate',
  });
}

function getDatabaseTelemetry(): DatabaseTelemetrySnapshot {
  initDatabase();
  return databaseTelemetry.snapshot(_sqlite!);
}

function withoutDatabaseObservation<T>(callback: () => T): T {
  return databaseTelemetry.withoutObservation(callback);
}

export {
  db,
  sqlite,
  schema,
  runTransaction,
  getDatabaseTelemetry,
  withoutDatabaseObservation,
};
export {
  shouldRunDatabaseInitialization,
} from './bootstrap/connection';
export {
  _runMigrationsIndividually,
} from './bootstrap/migrations';
export {
  _repairInboundWebhookNotificationActions,
} from './bootstrap/repairs/inbound-webhook';
export default db;
