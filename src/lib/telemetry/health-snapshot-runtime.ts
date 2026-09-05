import type {
  MaterializedHealthSummary,
  WorkerHealthSnapshot,
} from './health-snapshot';
import { createHealthSnapshotStore } from './database-health-runtime';

const healthSnapshotStore = createHealthSnapshotStore<MaterializedHealthSummary>();

export function writeWorkerHealthSnapshot(
  snapshot: WorkerHealthSnapshot,
  validate: () => void,
): Promise<void> {
  return healthSnapshotStore.write(snapshot, validate);
}

export function readWorkerHealthSnapshot(): Promise<WorkerHealthSnapshot | null> {
  return healthSnapshotStore.read();
}
