import type {
  AIEnrichmentInput,
  AIEnrichmentResult,
} from './ai-enrichment-policy';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export type { AIEnrichmentResult } from './ai-enrichment-policy';

export interface AIEnrichmentService {
  enrich(
    input: AIEnrichmentInput,
    options?: { signal?: AbortSignal },
  ): Promise<AIEnrichmentResult | null>;
}

let selectedService: AIEnrichmentService | null = null;

export function registerAIEnrichmentService(service: AIEnrichmentService): void {
  assertCanRegisterAIEnrichmentService(service);
  selectedService = service;
}

export function assertCanRegisterAIEnrichmentService(service: AIEnrichmentService): void {
  assertPersistenceCompositionPublicationAllowed();
  if (selectedService && selectedService !== service) {
    throw new Error('AI enrichment service is already selected');
  }
}

export function clearAIEnrichmentService(expectedService?: AIEnrichmentService): void {
  if (expectedService && selectedService !== expectedService) return;
  selectedService = null;
}

export function enrichWithAI(
  input: AIEnrichmentInput,
  options?: { signal?: AbortSignal },
): Promise<AIEnrichmentResult | null> {
  assertPersistenceCompositionAccessAllowed();
  if (!selectedService) {
    throw new Error('AI enrichment service is unavailable for the selected backend');
  }
  return selectedService.enrich(input, options);
}
