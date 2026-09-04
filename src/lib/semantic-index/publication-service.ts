import type { SemanticSourceEntityType } from './source/contracts';
import type { SemanticPublishResult } from './service';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export interface SemanticPublicationService {
  upsert(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticPublishResult | void>;
  delete(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticPublishResult | void>;
}

interface SemanticPublicationRegistry {
  selected: SemanticPublicationService | null;
}

const REGISTRY_KEY = 'mission-control.semantic-publication-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): SemanticPublicationRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
  }));
}

export function registerSemanticPublicationService(
  service: SemanticPublicationService,
): void {
  assertCanRegisterSemanticPublicationService(service);
  registry().selected = service;
}

export function assertCanRegisterSemanticPublicationService(
  service: SemanticPublicationService,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().selected;
  if (selected && selected !== service) {
    throw new Error('Semantic publication service is already selected');
  }
}

function getService(): SemanticPublicationService {
  assertPersistenceCompositionAccessAllowed();
  const selected = registry().selected;
  if (!selected) {
    throw new Error('Semantic publication service must be registered before publication');
  }
  return selected;
}

export function publishSemanticEntityUpsert(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult | void> {
  return getService().upsert(entityType, entityId);
}

export function publishSemanticEntityDelete(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult | void> {
  return getService().delete(entityType, entityId);
}
