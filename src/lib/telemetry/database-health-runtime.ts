import { sqlite, withoutDatabaseObservation } from '@/db';
import { PostgresDatabaseHealthProbe } from '@/db/postgres/health';
import { getPostgresPersistenceBackend } from '@/db/runtime';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type {
  HealthSnapshotStore,
} from './health-snapshot-store';
import type { DatabaseHealthProbe } from './database-health-probe';
import { PostgresHealthSnapshotStore } from './postgres-health-snapshot-store';
import { SqliteDatabaseHealthProbe } from './sqlite-database-health-probe';
import { SqliteHealthSnapshotStore } from './sqlite-health-snapshot-store';

const sqliteDatabaseHealthProbe = new SqliteDatabaseHealthProbe(
  sqlite,
  withoutDatabaseObservation,
);

function selectedDatabaseHealthProbe(): DatabaseHealthProbe {
  if (resolveDatabaseBackend() === 'sqlite') return sqliteDatabaseHealthProbe;
  return new PostgresDatabaseHealthProbe(
    getPostgresPersistenceBackend().context.pool,
  );
}

export const databaseHealthProbe: DatabaseHealthProbe = {
  inspect: () => selectedDatabaseHealthProbe().inspect(),
  hasSeedMarker: () => selectedDatabaseHealthProbe().hasSeedMarker(),
};

export function createHealthSnapshotStore<TSummary>(): HealthSnapshotStore<TSummary> {
  let selectedStore: HealthSnapshotStore<TSummary> | null = null;
  const getStore = (): HealthSnapshotStore<TSummary> => {
    if (selectedStore) return selectedStore;
    selectedStore = resolveDatabaseBackend() === 'sqlite'
      ? new SqliteHealthSnapshotStore<TSummary>(
          sqlite,
          withoutDatabaseObservation,
        )
      : new PostgresHealthSnapshotStore<TSummary>(
          getPostgresPersistenceBackend().context.db,
        );
    return selectedStore;
  };
  return {
    write: (snapshot, validate) => getStore().write(snapshot, validate),
    read: () => getStore().read(),
  };
}
