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

// Keep connection creation lazy so Next.js build workers do not race to open
// the database during static analysis.
let _sqlite: Database.Database | null = null;
let _observedSqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;
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

function initDatabase(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
} {
  if (_observedSqlite && _db) return { sqlite: _observedSqlite, db: _db };
  if (_sqlite || _observedSqlite || _db) resetPartialDatabaseInitialization();

  _sqlite = openDatabaseConnection();
  configureDatabaseConnection(_sqlite);

  _observedSqlite = createObservedDatabase(_sqlite, databaseTelemetry);
  const localDb = drizzle(_observedSqlite, { schema });

  if (shouldRunDatabaseInitialization()) {
    runOrderedDatabaseBootstrap(_sqlite, path.join(process.cwd(), 'drizzle'));
  }

  _db = localDb;
  databaseTelemetry.reset();
  return { sqlite: _observedSqlite, db: _db };
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
