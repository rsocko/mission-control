import type { DatabaseHealthProbe } from './database-health-probe';
import type { HealthSnapshotStore } from './health-snapshot-store';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export interface RuntimeHealthPersistence {
  databaseHealthProbe: DatabaseHealthProbe;
  createHealthSnapshotStore<TSummary>(): HealthSnapshotStore<TSummary>;
}

interface RuntimeHealthPersistenceRegistry {
  selected: RuntimeHealthPersistence | null;
}

const REGISTRY_KEY = 'mission-control.runtime-health-persistence-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): RuntimeHealthPersistenceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
  }));
}

export function registerRuntimeHealthPersistence(
  persistence: RuntimeHealthPersistence,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (state.selected && state.selected !== persistence) {
    throw new Error('Runtime health persistence is already selected');
  }
  state.selected = persistence;
}

export function clearRuntimeHealthPersistence(
  persistence: RuntimeHealthPersistence,
): void {
  const state = registry();
  if (state.selected === persistence) state.selected = null;
}

export function getRuntimeHealthPersistence(): RuntimeHealthPersistence {
  assertPersistenceCompositionAccessAllowed();
  const persistence = registry().selected;
  if (!persistence) {
    throw new Error(
      'Runtime health persistence has not been registered. Initialize the database '
      + 'runtime before using health persistence.',
    );
  }
  return persistence;
}

export const databaseHealthProbe: DatabaseHealthProbe = {
  inspect: () => getRuntimeHealthPersistence().databaseHealthProbe.inspect(),
  hasSeedMarker: () => getRuntimeHealthPersistence().databaseHealthProbe.hasSeedMarker(),
};

export function createHealthSnapshotStore<TSummary>(): HealthSnapshotStore<TSummary> {
  return {
    write: (snapshot, validate) => (
      getRuntimeHealthPersistence()
        .createHealthSnapshotStore<TSummary>()
        .write(snapshot, validate)
    ),
    read: () => (
      getRuntimeHealthPersistence()
        .createHealthSnapshotStore<TSummary>()
        .read()
    ),
  };
}
