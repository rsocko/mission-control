import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface PersistenceCompositionLifecycle {
  publicationBlocked: boolean;
  accessBlocked: boolean;
}

const LIFECYCLE_KEY = 'mission-control.persistence-composition-lifecycle';
const LIFECYCLE_SCHEMA_VERSION = 1;

function lifecycle(): PersistenceCompositionLifecycle {
  return getProcessRuntimeSlot(LIFECYCLE_KEY, LIFECYCLE_SCHEMA_VERSION, () => ({
    publicationBlocked: false,
    accessBlocked: false,
  }));
}

export function beginPersistenceCompositionInitialization(): void {
  const state = lifecycle();
  state.publicationBlocked = false;
  state.accessBlocked = true;
}

export function completePersistenceCompositionInitialization(): void {
  lifecycle().accessBlocked = false;
}

export function blockPersistenceComposition(): void {
  const state = lifecycle();
  state.publicationBlocked = true;
  state.accessBlocked = true;
}

export function isPersistenceCompositionAccessBlocked(): boolean {
  return lifecycle().accessBlocked;
}

export function assertPersistenceCompositionPublicationAllowed(): void {
  if (lifecycle().publicationBlocked) {
    throw new Error(
      'Persistence composition publication is blocked until initializeRuntimeDatabase() starts a new generation',
    );
  }
}

export function assertPersistenceCompositionAccessAllowed(): void {
  if (lifecycle().accessBlocked) {
    throw new Error(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
  }
}
