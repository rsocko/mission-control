import { PostgresDatabaseHealthProbe } from '@/db/postgres/health';
import { getPostgresPersistenceBackend } from '@/db/runtime';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type {
  HealthSnapshotStore,
} from './health-snapshot-store';
import type { DatabaseHealthProbe } from './database-health-probe';
import { PostgresHealthSnapshotStore } from './postgres-health-snapshot-store';

async function selectedDatabaseHealthProbe(): Promise<DatabaseHealthProbe> {
  if (resolveDatabaseBackend() === 'postgres') {
    return new PostgresDatabaseHealthProbe(
      getPostgresPersistenceBackend().context.pool,
    );
  }
  const [
    { sqlite, withoutDatabaseObservation },
    { SqliteDatabaseHealthProbe },
  ] = await Promise.all([
    import('@/db'),
    import('./sqlite-database-health-probe'),
  ]);
  return new SqliteDatabaseHealthProbe(sqlite, withoutDatabaseObservation);
}

export const databaseHealthProbe: DatabaseHealthProbe = {
  inspect: async () => (await selectedDatabaseHealthProbe()).inspect(),
  hasSeedMarker: async () => (await selectedDatabaseHealthProbe()).hasSeedMarker(),
};

export function createHealthSnapshotStore<TSummary>(): HealthSnapshotStore<TSummary> {
  let selectedStore: Promise<HealthSnapshotStore<TSummary>> | null = null;
  const getStore = (): Promise<HealthSnapshotStore<TSummary>> => {
    if (selectedStore) return selectedStore;
    selectedStore = resolveDatabaseBackend() === 'postgres'
      ? Promise.resolve(new PostgresHealthSnapshotStore<TSummary>(
          getPostgresPersistenceBackend().context.db,
        ))
      : Promise.all([
          import('@/db'),
          import('./sqlite-health-snapshot-store'),
        ]).then(([{ sqlite, withoutDatabaseObservation }, { SqliteHealthSnapshotStore }]) =>
          new SqliteHealthSnapshotStore<TSummary>(sqlite, withoutDatabaseObservation));
    return selectedStore;
  };
  return {
    write: async (snapshot, validate) => (await getStore()).write(snapshot, validate),
    read: async () => (await getStore()).read(),
  };
}
