let publicationBlocked = false;
let accessBlocked = false;

export function beginPersistenceCompositionInitialization(): void {
  publicationBlocked = false;
  accessBlocked = true;
}

export function completePersistenceCompositionInitialization(): void {
  accessBlocked = false;
}

export function blockPersistenceComposition(): void {
  publicationBlocked = true;
  accessBlocked = true;
}

export function isPersistenceCompositionAccessBlocked(): boolean {
  return accessBlocked;
}

export function assertPersistenceCompositionPublicationAllowed(): void {
  if (publicationBlocked) {
    throw new Error(
      'Persistence composition publication is blocked until initializeRuntimeDatabase() starts a new generation',
    );
  }
}

export function assertPersistenceCompositionAccessAllowed(): void {
  if (accessBlocked) {
    throw new Error(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
  }
}
