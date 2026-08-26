import { sqlite, withoutDatabaseObservation } from '@/db';
import type {
  HealthSnapshotStore,
} from './health-snapshot-store';
import { SqliteDatabaseHealthProbe } from './sqlite-database-health-probe';
import { SqliteHealthSnapshotStore } from './sqlite-health-snapshot-store';

export const databaseHealthProbe = new SqliteDatabaseHealthProbe(
  sqlite,
  withoutDatabaseObservation,
);

export function createHealthSnapshotStore<TSummary>(): HealthSnapshotStore<TSummary> {
  return new SqliteHealthSnapshotStore<TSummary>(
    sqlite,
    withoutDatabaseObservation,
  );
}
