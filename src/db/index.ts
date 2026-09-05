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
import {
  assertPersistenceCompositionPublicationAllowed,
  isPersistenceCompositionAccessBlocked,
} from '@/lib/persistence/composition-lifecycle';
import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';
import type { SemanticSearchRuntime } from '@/lib/search/semantic';
import {
  getSemanticIndexRuntime,
  scheduleSemanticBackfill,
} from '@/lib/semantic-index/runtime';

// Keep connection creation lazy so Next.js build workers do not race to open
// the database during static analysis.
let _sqlite: Database.Database | null = null;
let _observedSqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;
let sqliteComposition: {
  coreRepositories: CorePersistenceRepositories;
  workerRepositories: WorkerPersistenceRepositories;
  taskCorePersistence: TaskCorePersistence;
  borrowsTriage: boolean;
} | null = null;
type SqliteCompositionModules = {
  createCoreRepositories:
    typeof import('./persistence/sqlite-core-repositories').createSqliteCorePersistenceRepositories;
  workerRuntime: typeof import('./persistence/sqlite-worker-runtime');
  coreRuntime: typeof import('@/lib/persistence/runtime');
  workerPersistenceRuntime: typeof import('@/lib/persistence/worker-runtime');
  triageRuntime: typeof import('@/lib/triage/persistence');
  taskCoreRuntime: typeof import('@/lib/tasks/core/runtime');
  taskCorePersistence:
    typeof import('./persistence/sqlite-task-core-repositories').sqliteTaskCorePersistence;
  semanticSearch: typeof import('@/lib/search/semantic');
};
let sqliteCompositionModules: SqliteCompositionModules | null = null;
let sqliteCompositionModulesPromise: Promise<SqliteCompositionModules> | null = null;
let sqliteCompositionPromise: Promise<void> | null = null;
let sqliteCompositionShutdownPromise: Promise<void> | null = null;
let sqliteCompositionState: 'cold' | 'initializing' | 'active' | 'stopping' | 'stopped' = 'cold';
const databaseTelemetry = new DatabaseTelemetryCollector();
const sqliteSemanticSearchRuntime: SemanticSearchRuntime = {
  async resolve() {
    const { repository, embeddings } = await getSemanticIndexRuntime();
    return { repository, embeddings };
  },
  async scheduleBackfill() {
    return scheduleSemanticBackfill();
  },
};

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
  if (isPersistenceCompositionAccessBlocked()) {
    throw new Error(
      'SQLite compatibility access is blocked after shutdown until initializeRuntimeDatabase() starts a new generation',
    );
  }
}

async function loadSqliteCompositionModules(): Promise<SqliteCompositionModules> {
  if (sqliteCompositionModules) return sqliteCompositionModules;
  if (sqliteCompositionModulesPromise) return sqliteCompositionModulesPromise;
  const pending = Promise.all([
    import('./persistence/sqlite-core-repositories'),
    import('./persistence/sqlite-worker-runtime'),
    import('@/lib/persistence/runtime'),
    import('@/lib/persistence/worker-runtime'),
    import('@/lib/triage/persistence'),
    import('@/lib/tasks/core/runtime'),
    import('./persistence/sqlite-task-core-repositories'),
    import('@/lib/search/semantic'),
  ]).then(([
    core,
    workerRuntime,
    coreRuntime,
    workerPersistenceRuntime,
    triageRuntime,
    taskCoreRuntime,
    taskCorePersistence,
    semanticSearch,
  ]) => ({
    createCoreRepositories: core.createSqliteCorePersistenceRepositories,
    workerRuntime,
    coreRuntime,
    workerPersistenceRuntime,
    triageRuntime,
    taskCoreRuntime,
    taskCorePersistence: taskCorePersistence.sqliteTaskCorePersistence,
    semanticSearch,
  }));
  sqliteCompositionModulesPromise = pending;
  try {
    sqliteCompositionModules = await pending;
    return sqliteCompositionModules;
  } finally {
    if (sqliteCompositionModulesPromise === pending) {
      sqliteCompositionModulesPromise = null;
    }
  }
}

function getOrCreateSqliteComposition(
  modules: SqliteCompositionModules,
): NonNullable<typeof sqliteComposition> {
  const localSqlite = _observedSqlite;
  const localDb = _db;
  if (!localSqlite || !localDb) {
    throw new Error('SQLite must be initialized before persistence composition');
  }
  if (!sqliteComposition) {
    const coreRepositories = modules.createCoreRepositories(localSqlite);
    const workerRepositories = modules.workerRuntime.createSqliteWorkerPersistenceRepositories(
      localSqlite,
      localDb,
      coreRepositories,
    );
    const triageRegistration =
      modules.triageRuntime.getTriagePersistenceRegistrationForComposition();
    const borrowedTriage = triageRegistration?.accessed
      ? triageRegistration.repositories
      : null;
    sqliteComposition = {
      coreRepositories,
      workerRepositories: borrowedTriage
        ? { ...workerRepositories, triage: borrowedTriage }
        : workerRepositories,
      taskCorePersistence: modules.taskCorePersistence,
      borrowsTriage: borrowedTriage !== null,
    };
  }
  return sqliteComposition;
}

function publishSqliteComposition(modules: SqliteCompositionModules): void {
  const composition = getOrCreateSqliteComposition(modules);

  modules.coreRuntime.assertCanRegisterCorePersistenceRepositories(
    composition.coreRepositories,
  );
  if (composition.borrowsTriage) {
    modules.workerPersistenceRuntime
      .assertCanRegisterWorkerPersistenceRepositoriesWithBorrowedTriage(
        composition.workerRepositories,
      );
  } else {
    modules.workerPersistenceRuntime.assertCanRegisterWorkerPersistenceRepositories(
      composition.workerRepositories,
    );
  }
  modules.workerRuntime.assertCanRegisterSqliteWorkerRuntimeServices();
  modules.semanticSearch.assertCanRegisterSemanticSearchRuntime(
    sqliteSemanticSearchRuntime,
  );

  try {
    modules.coreRuntime.registerCorePersistenceRepositories(composition.coreRepositories);
    if (composition.borrowsTriage) {
      modules.workerPersistenceRuntime.registerWorkerPersistenceRepositoriesWithBorrowedTriage(
        composition.workerRepositories,
      );
    } else {
      modules.workerPersistenceRuntime.registerWorkerPersistenceRepositories(
        composition.workerRepositories,
      );
    }
    modules.workerRuntime.registerSqliteWorkerRuntimeServices();
    modules.taskCoreRuntime.registerTaskCorePersistence(composition.taskCorePersistence);
    modules.semanticSearch.registerSemanticSearchRuntime(sqliteSemanticSearchRuntime);
    sqliteCompositionState = 'active';
  } catch (error) {
    modules.semanticSearch.clearSemanticSearchRuntime(sqliteSemanticSearchRuntime);
    modules.taskCoreRuntime.clearSelectedTaskCorePersistence(
      composition.taskCorePersistence,
    );
    modules.workerRuntime.clearSqliteWorkerRuntimeServices();
    modules.workerPersistenceRuntime.clearWorkerPersistenceRepositories(
      composition.workerRepositories,
    );
    modules.coreRuntime.clearCorePersistenceRepositories(composition.coreRepositories);
    throw error;
  }
}

function initDatabase(options: { allowCompositionInitialization?: boolean } = {}): {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
} {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'This workflow still uses the SQLite compatibility API and is not supported by the PostgreSQL backend',
    );
  }
  if (!options.allowCompositionInitialization) {
    assertSqliteCompatibilityAccessAllowed();
  }
  assertPersistenceCompositionPublicationAllowed();
  if (_observedSqlite && _db) {
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
  initDatabase({ allowCompositionInitialization: true });
}

export function initializeSqlitePersistenceComposition(): Promise<void> {
  if (sqliteCompositionState === 'active') return Promise.resolve();
  if (sqliteCompositionPromise) return sqliteCompositionPromise;
  if (sqliteCompositionState === 'stopping') {
    return Promise.reject(new Error('SQLite persistence composition shutdown is in progress'));
  }

  const retryState = sqliteCompositionState === 'stopped' ? 'stopped' : 'cold';
  sqliteCompositionState = 'initializing';
  const pending = Promise.resolve().then(async () => {
    try {
      const modules = await loadSqliteCompositionModules();
      if (sqliteCompositionState !== 'initializing') {
        throw new Error('SQLite persistence composition initialization was invalidated');
      }
      initDatabase({ allowCompositionInitialization: true });
      publishSqliteComposition(modules);
    } catch (error) {
      if (sqliteCompositionState !== 'stopping') sqliteCompositionState = retryState;
      throw error;
    }
  });
  const tracked = pending.finally(() => {
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
      if (!sqliteCompositionModules) {
        throw new Error('SQLite persistence composition modules are unavailable during shutdown');
      }
      sqliteCompositionModules.workerRuntime.clearSqliteWorkerRuntimeServices();
      sqliteCompositionModules.workerPersistenceRuntime.clearWorkerPersistenceRepositories(
        sqliteComposition.workerRepositories,
      );
      sqliteCompositionModules.coreRuntime.clearCorePersistenceRepositories(
        sqliteComposition.coreRepositories,
      );
      sqliteCompositionModules.taskCoreRuntime.clearSelectedTaskCorePersistence(
        sqliteComposition.taskCorePersistence,
      );
      sqliteCompositionModules.semanticSearch.clearSemanticSearchRuntime(
        sqliteSemanticSearchRuntime,
      );
    }
    sqliteCompositionState = 'stopped';
  })();
  const tracked = pending.finally(() => {
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
