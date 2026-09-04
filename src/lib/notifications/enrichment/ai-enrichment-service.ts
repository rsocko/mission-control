import type {
  AIEnrichmentInput,
  AIEnrichmentResult,
} from './ai-enrichment-policy';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export type { AIEnrichmentResult } from './ai-enrichment-policy';

export interface AIEnrichmentService {
  enrich(
    input: AIEnrichmentInput,
    options?: { signal?: AbortSignal },
  ): Promise<AIEnrichmentResult | null>;
}

interface AIEnrichmentRegistry {
  selected: AIEnrichmentService | null;
}

const REGISTRY_KEY = 'mission-control.ai-enrichment-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): AIEnrichmentRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
  }));
}

export function registerAIEnrichmentService(service: AIEnrichmentService): void {
  assertCanRegisterAIEnrichmentService(service);
  registry().selected = service;
}

export function assertCanRegisterAIEnrichmentService(service: AIEnrichmentService): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().selected;
  if (selected && selected !== service) {
    throw new Error('AI enrichment service is already selected');
  }
}

export function clearAIEnrichmentService(expectedService?: AIEnrichmentService): void {
  const state = registry();
  if (expectedService && state.selected !== expectedService) return;
  state.selected = null;
}

export function enrichWithAI(
  input: AIEnrichmentInput,
  options?: { signal?: AbortSignal },
): Promise<AIEnrichmentResult | null> {
  assertPersistenceCompositionAccessAllowed();
  const selected = registry().selected;
  if (!selected) {
    throw new Error('AI enrichment service is unavailable for the selected backend');
  }
  return selected.enrich(input, options);
}
