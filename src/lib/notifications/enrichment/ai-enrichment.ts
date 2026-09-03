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

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface AIEnrichmentInput {
  notificationId: string;
  title: string;
  body?: string | null;
  connectorType: string;
  category: string;
  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;
}

export interface AIEnrichmentResult {
  /** AI-generated one-line summary */
  summary?: string;
  /** Suggested action type */
  suggestedAction?: string;
  /** Reason for suggested action */
  suggestedActionReason?: string;
  /** Whether AI thinks this is more urgent than rule-based level suggests */
  urgencyBoost?: boolean;
  /** Additional context tags AI extracted */
  contextTags?: string[];
}

export class NotificationEnrichmentPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationEnrichmentPermanentError';
  }
}

export function parseAIEnrichmentResult(text: string): AIEnrichmentResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new NotificationEnrichmentPermanentError('AI response did not contain JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new NotificationEnrichmentPermanentError('AI response contained invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotificationEnrichmentPermanentError('AI response JSON must be an object');
  }
  const result = parsed as AIEnrichmentResult;
  return {
    summary: typeof result.summary === 'string' ? result.summary : undefined,
    suggestedAction: typeof result.suggestedAction === 'string'
      ? result.suggestedAction
      : undefined,
    suggestedActionReason: typeof result.suggestedActionReason === 'string'
      ? result.suggestedActionReason
      : undefined,
    urgencyBoost: result.urgencyBoost === true,
    contextTags: Array.isArray(result.contextTags)
      ? result.contextTags.filter((tag): tag is string => typeof tag === 'string')
      : undefined,
  };
}

// ─── ENRICHMENT RULES ───────────────────────────────────────────────────────

/**
 * Determines whether a notification is worth sending to AI for enrichment.
 * We don't want to burn AI calls on simple FYI/digest notifications.
 */
export function shouldEnrichWithAI(input: AIEnrichmentInput): boolean {
  // Always enrich actionable categories
  const enrichableCategories = ['development', 'social', 'security', 'tasks'];
  if (enrichableCategories.includes(input.category)) return true;

  // Enrich if it's a PR review (complex enough to benefit from summary)
  const presentation = input.presentation as { subjectType?: string; reason?: string };
  if (presentation.reason === 'review_requested') return true;
  if (presentation.reason === 'security_alert') return true;

  // Don't enrich simple system/digest notifications
  return false;
}

// ─── PROMPT GENERATION ──────────────────────────────────────────────────────

/**
 * Builds the prompt for AI enrichment. This is designed to work with
 * the existing AI assistant infrastructure.
 */
export function buildEnrichmentPrompt(input: AIEnrichmentInput): string {
  const presentation = input.presentation as Record<string, string | number | undefined>;

  return `Analyze this notification and provide a brief, actionable summary:

Source: ${input.connectorType}
Category: ${input.category}
Title: ${input.title}
Body: ${input.body || 'N/A'}
Repository: ${presentation.repository || 'N/A'}
Entity: ${presentation.subjectType || 'unknown'} ${presentation.entityNumber ? `#${presentation.entityNumber}` : ''}
Reason: ${presentation.reasonLabel || presentation.reason || 'N/A'}

Respond with JSON:
{
  "summary": "One-sentence summary of what requires attention",
  "suggestedAction": "create_task | open_url | snooze | dismiss",
  "suggestedActionReason": "Why this action makes sense",
  "urgencyBoost": false,
  "contextTags": ["tag1", "tag2"]
}`;
}

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
