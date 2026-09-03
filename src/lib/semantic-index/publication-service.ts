import type { SemanticSourceEntityType } from './source/contracts';
import type { SemanticPublishResult } from './service';

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
  if (selectedService && selectedService !== service) {
    throw new Error('Semantic publication service is already selected');
  }
  selectedService = service;
}

function getService(): SemanticPublicationService {
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
