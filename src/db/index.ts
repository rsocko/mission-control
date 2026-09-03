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
  createSqliteWorkerPersistenceRepositories,
  registerSqliteWorkerRuntimeServices,
} from './persistence/sqlite-worker-runtime';
import { registerCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { registerWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';

// Keep connection creation lazy so Next.js build workers do not race to open
// the database during static analysis.
let _sqlite: Database.Database | null = null;
let _observedSqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;
let sqliteCompositionRegistered = false;
let pendingSqliteComposition: {
  sqlite: Database.Database;
  observedSqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  coreRepositories: CorePersistenceRepositories;
  workerRepositories: WorkerPersistenceRepositories;
} | null = null;
const databaseTelemetry = new DatabaseTelemetryCollector();

function resetPartialDatabaseInitialization(): void {
  try {
    (_sqlite ?? pendingSqliteComposition?.sqlite)?.close();
  } catch {
    // The original initialization error is more useful than a cleanup error.
  }
  _sqlite = null;
  _observedSqlite = null;
  _db = null;
  pendingSqliteComposition = null;
}

function publishSqliteComposition(
  composition: NonNullable<typeof pendingSqliteComposition>,
): void {
  registerSqliteWorkerRuntimeServices();
  registerCorePersistenceRepositories(composition.coreRepositories);
  registerWorkerPersistenceRepositories(composition.workerRepositories);
  _sqlite = composition.sqlite;
  _observedSqlite = composition.observedSqlite;
  _db = composition.db;
  sqliteCompositionRegistered = true;
  pendingSqliteComposition = null;
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
  if (_observedSqlite && _db && sqliteCompositionRegistered) {
    return { sqlite: _observedSqlite, db: _db };
  }
  if (pendingSqliteComposition) {
    const composition = pendingSqliteComposition;
    publishSqliteComposition(composition);
    return { sqlite: composition.observedSqlite, db: composition.db };
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

    const coreRepositories = createSqliteCorePersistenceRepositories(observedSqlite);
    const workerRepositories = createSqliteWorkerPersistenceRepositories(
      observedSqlite,
      localDb,
      coreRepositories,
    );
    pendingSqliteComposition = {
      sqlite,
      observedSqlite,
      db: localDb,
      coreRepositories,
      workerRepositories,
    };
    publishSqliteComposition(pendingSqliteComposition);
    databaseTelemetry.reset();
    return { sqlite: observedSqlite, db: localDb };
  } catch (error) {
    if (!pendingSqliteComposition) {
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
