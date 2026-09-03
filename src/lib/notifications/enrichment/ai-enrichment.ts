/**
 * AI Enrichment
 *
 * Optional async pass that uses AI to enrich notifications with:
 * - Summarized descriptions for complex notifications
 * - Suggested actions based on notification context
 * - Priority/urgency hints the rule-based system might miss
 *
 * This module is designed to run asynchronously after the notification
 * is persisted — it updates the notification in place rather than blocking
 * the sync pipeline.
 */

import {
  buildEnrichmentPrompt,
  NotificationEnrichmentPermanentError,
  parseAIEnrichmentResult,
  shouldEnrichWithAI,
  type AIEnrichmentInput,
  type AIEnrichmentResult,
} from './ai-enrichment-policy';
import { registerAIEnrichmentService } from './ai-enrichment-service';

export {
  buildEnrichmentPrompt,
  NotificationEnrichmentPermanentError,
  parseAIEnrichmentResult,
  shouldEnrichWithAI,
  type AIEnrichmentInput,
  type AIEnrichmentResult,
} from './ai-enrichment-policy';

// ─── ENRICHMENT EXECUTION ───────────────────────────────────────────────────

/**
 * Runs AI enrichment on a notification. This is designed to be called
 * asynchronously after the notification is persisted.
 *
 * Returns null if enrichment is skipped or fails gracefully.
 */
export async function enrichWithAI(
  input: AIEnrichmentInput,
  options: { signal?: AbortSignal } = {},
): Promise<AIEnrichmentResult | null> {
  if (!shouldEnrichWithAI(input)) {
    return null;
  }

  // Dynamic import to avoid circular dependencies with AI module
  const { generateText } = await import('ai');
  const { getAIModel } = await import('@/lib/ai/provider-factory');

  const prompt = buildEnrichmentPrompt(input);
  const route = getAIModel('notification-enrichment', {
    sources: [input.connectorType],
  });

  const { text } = await generateText({
    model: route.model,
    prompt,
    abortSignal: options.signal,
  });

  return parseAIEnrichmentResult(text);
}

// ─── BATCH ENRICHMENT ───────────────────────────────────────────────────────

/**
 * Enrich multiple notifications. Processes sequentially to respect rate limits.
 * Returns a map of notification index → enrichment result.
 */
export async function enrichBatchWithAI(
  inputs: AIEnrichmentInput[],
): Promise<Map<number, AIEnrichmentResult>> {
  const results = new Map<number, AIEnrichmentResult>();

  for (let i = 0; i < inputs.length; i++) {
    const result = await enrichWithAI(inputs[i]);
    if (result) {
      results.set(i, result);
    }
  }

  return results;
}

const sqliteAIEnrichmentService = { enrich: enrichWithAI };

export function registerSqliteAIEnrichmentService(): void {
  registerAIEnrichmentService(sqliteAIEnrichmentService);
}
