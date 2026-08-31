import { generateText } from 'ai';
import logger from '@/lib/logger';
import type { TriageItem } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedAction {
  /** Action-oriented task title */
  title: string;
  /** Optional description or context */
  description?: string;
  /** Confidence score 0–1 */
  confidence: number;
}

export interface MultiActionResult {
  /** Whether multiple actions were detected */
  isMultiAction: boolean;
  /** Extracted actions (1+ items) */
  actions: ExtractedAction[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a task extraction assistant. Given a triage item (captured content from the web, an article, a social post, etc.), identify ALL distinct actionable items that a user might want to create as separate tasks.

Rules:
- Each action should be a single, concrete thing to do
- Use action-oriented titles starting with a verb (e.g. "Evaluate", "Read", "Try", "Set up")
- If the content only suggests ONE action, return exactly one item
- Return 2+ items ONLY when the content genuinely contains multiple distinct actions
- Do NOT split a single action into sub-steps
- Keep titles concise (under 80 characters)
- Set confidence between 0.0 and 1.0 based on how clearly the action is implied

Return ONLY valid JSON in this exact format:
{"actions": [{"title": "...", "description": "...", "confidence": 0.9}]}`;

// ─── Extraction ─────────────────────────────────────────────────────────────

function buildContentString(item: TriageItem): string {
  const parts: string[] = [];

  if (item.title) parts.push(`Title: ${item.title}`);
  if (item.description) parts.push(`Description: ${item.description}`);
  if (item.aiSummary) parts.push(`Summary: ${item.aiSummary}`);
  if (item.sourceUrl) parts.push(`Source: ${item.sourceUrl}`);
  if (item.sourcePlatform) parts.push(`Platform: ${item.sourcePlatform}`);
  if (item.aiCategories?.length) parts.push(`Categories: ${item.aiCategories.join(', ')}`);

  return parts.join('\n');
}

/**
 * Use AI to detect multiple actionable items in a triage item.
 * Falls back to a single action derived from the title if AI is unavailable.
 */
export async function extractMultipleActions(item: TriageItem): Promise<MultiActionResult> {
  const contentStr = buildContentString(item);

  try {
    const { getAIModel } = await import('@/lib/ai/provider-factory');
    const route = getAIModel('triage-action-extraction', {
      sources: item.sourcePlatform ? [item.sourcePlatform] : [],
    });

    const result = await generateText({
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentStr }],
    });

    const parsed = JSON.parse(result.text);

    if (parsed.actions && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      const actions: ExtractedAction[] = parsed.actions.map(
        (a: { title?: string; description?: string; confidence?: number }) => ({
          title: String(a.title || '').trim(),
          description: a.description ? String(a.description).trim() : undefined,
          confidence: typeof a.confidence === 'number' ? Math.min(1, Math.max(0, a.confidence)) : 0.5,
        })
      ).filter((a: ExtractedAction) => a.title);

      return {
        isMultiAction: actions.length > 1,
        actions,
      };
    }
  } catch (err) {
    logger.warn({ err, triageItemId: item.id }, 'AI multi-action extraction failed, falling back to single action');
  }

  // Fallback: single action from the item title
  return {
    isMultiAction: false,
    actions: [{
      title: item.title || 'Review captured item',
      confidence: 1.0,
    }],
  };
}
