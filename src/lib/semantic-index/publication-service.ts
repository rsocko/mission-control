import type { SemanticSourceEntityType } from './source/contracts';
import type { SemanticPublishResult } from './service';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

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

let selectedService: SemanticPublicationService | null = null;

export function registerSemanticPublicationService(
  service: SemanticPublicationService,
): void {
  assertCanRegisterSemanticPublicationService(service);
  selectedService = service;
}

export function assertCanRegisterSemanticPublicationService(
  service: SemanticPublicationService,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (selectedService && selectedService !== service) {
    throw new Error('Semantic publication service is already selected');
  }
}

function getService(): SemanticPublicationService {
  assertPersistenceCompositionAccessAllowed();
  if (!selectedService) {
    throw new Error('Semantic publication service must be registered before publication');
  }
  return selectedService;
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
