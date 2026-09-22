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
  summary?: string;
  suggestedAction?: string;
  suggestedActionReason?: string;
  urgencyBoost?: boolean;
  contextTags?: string[];
}

export class NotificationEnrichmentPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationEnrichmentPermanentError';
  }
}

export function shouldEnrichWithAI(input: AIEnrichmentInput): boolean {
  if (['development', 'social', 'security', 'tasks'].includes(input.category)) {
    return true;
  }

  const presentation = input.presentation as { reason?: string };
  return presentation.reason === 'review_requested'
    || presentation.reason === 'security_alert';
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
