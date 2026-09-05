import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
import type { ScoutStatusChangeRepository } from './status-change-repository';

interface ScoutStatusChangeRuntimeRegistry {
  repository: ScoutStatusChangeRepository | null;
  accessed: boolean;
}

const REGISTRY_KEY = 'mission-control.scout-status-change-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): ScoutStatusChangeRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repository: null,
    accessed: false,
  }));
}

export function assertCanRegisterScoutStatusChangeRepository(
  repository: ScoutStatusChangeRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (state.repository && state.repository !== repository && state.accessed) {
    throw new Error('Scout status-change repository is already registered');
  }
}

export function registerScoutStatusChangeRepository(
  repository: ScoutStatusChangeRepository,
): void {
  assertCanRegisterScoutStatusChangeRepository(repository);
  registry().repository = repository;
}

export function clearScoutStatusChangeRepository(
  repository: ScoutStatusChangeRepository,
): void {
  const state = registry();
  if (state.repository !== repository) return;
  state.repository = null;
  state.accessed = false;
}

export function getScoutStatusChangeRepository(): ScoutStatusChangeRepository {
  assertPersistenceCompositionAccessAllowed();
  const state = registry();
  state.accessed = true;
  if (!state.repository) {
    throw new Error('Scout status-change repository has not been registered');
  }
  return state.repository;
}
