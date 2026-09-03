import type {
  AIEnrichmentInput,
  AIEnrichmentResult,
} from './ai-enrichment-policy';

export type { AIEnrichmentResult } from './ai-enrichment-policy';

export interface AIEnrichmentService {
  enrich(
    input: AIEnrichmentInput,
    options?: { signal?: AbortSignal },
  ): Promise<AIEnrichmentResult | null>;
}

let selectedService: AIEnrichmentService | null = null;

export function registerAIEnrichmentService(service: AIEnrichmentService): void {
  if (selectedService && selectedService !== service) {
    throw new Error('AI enrichment service is already selected');
  }
  selectedService = service;
}

export function clearAIEnrichmentService(): void {
  selectedService = null;
}

export function enrichWithAI(
  input: AIEnrichmentInput,
  options?: { signal?: AbortSignal },
): Promise<AIEnrichmentResult | null> {
  if (!selectedService) {
    throw new Error('AI enrichment service is unavailable for the selected backend');
  }
  return selectedService.enrich(input, options);
}
