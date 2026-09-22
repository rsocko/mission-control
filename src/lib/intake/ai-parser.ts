/**
 * AI-powered document parser — final fallback when deterministic parsers
 * fail to extract any findings from the pasted content.
 *
 * Uses the configured AI provider (via Vercel AI SDK) to extract structured
 * findings from arbitrary document formats.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getAsyncAIModel } from '@/lib/ai/provider-runtime';
import type { ParsedDocument, Finding, PhaseDefinition, PriorityGroup } from './document-intake';
import logger from '@/lib/logger';

const INTAKE_PARSE_PROMPT = `You are a document parser for a task management system. Extract actionable work items from the provided document.

Rules:
- Extract EVERY actionable task/item/finding from the document
- Assign each a short unique ID like F-1, F-2, etc.
- Group items into phases if the document has clear sections/phases/stages
- Determine an overall priority (1=highest, 4=lowest) from context clues
- For "area", use the section/category the item belongs to
- For "effort", use any effort/complexity hints (e.g., "Low", "Medium", "High", "1-2 days", "1 week")
- For "issue", use the full task description text
- For "impact", summarize why this matters (can be brief)
- For "suggestedFix", include any implementation hints or referenced issue numbers
- If the document mentions GitHub issues (#NNN), include them in suggestedFix
- Return an empty findings array ONLY if the document truly contains no actionable items

Be thorough — extract ALL items, not just a subset.`;

const findingSchema = z.object({
  id: z.string().describe('Unique ID like F-1, F-2'),
  area: z.string().describe('Category/section this belongs to'),
  issue: z.string().describe('Full task/finding description'),
  impact: z.string().describe('Why this matters (brief)'),
  suggestedFix: z.string().describe('Implementation hints or issue refs'),
  effort: z.string().describe('Effort estimate if available'),
  priorityOrder: z.number().describe('Priority 1-4 (1=highest)'),
  priorityTitle: z.string().describe('Priority group title'),
  priorityLabel: z.string().describe('Priority label like "Priority 1"'),
  linkedIssueNumbers: z.array(z.number()).describe('GitHub issue numbers referenced in this item (e.g. [865, 900])'),
});

const phaseSchema = z.object({
  name: z.string().describe('Phase name'),
  description: z.string().describe('Phase description'),
  estimatedDays: z.number().nullable().describe('Estimated days or null'),
  sortOrder: z.number().describe('Phase order (0-based)'),
  findingIds: z.array(z.string()).describe('IDs of findings in this phase'),
});

const parsedDocumentSchema = z.object({
  title: z.string().nullable().describe('Document/project title'),
  findings: z.array(findingSchema),
  phases: z.array(phaseSchema),
  priorityGroups: z.array(
    z.object({
      order: z.number(),
      title: z.string(),
      label: z.string(),
      findingIds: z.array(z.string()),
    }),
  ),
});

/**
 * Parse a document using AI when deterministic parsers fail.
 * Returns null if AI is not configured or the call fails (graceful degradation).
 */
export async function parseDocumentWithAI(
  content: string,
  signal?: AbortSignal,
): Promise<ParsedDocument | null> {
  try {
    signal?.throwIfAborted();
    // Guard against excessively large documents that would blow token limits
    const truncated = content.length > 30000 ? content.slice(0, 30000) : content;

    const route = await getAsyncAIModel('document-intake', {
      sources: ['document-intelligence'],
    });

    const { object } = await generateObject({
      model: route.model,
      schema: parsedDocumentSchema,
      abortSignal: signal,
      system: INTAKE_PARSE_PROMPT,
      prompt: `Parse the following document and extract all actionable items:\n\n${truncated}`,
    });

    // Validate the response has findings
    if (!object.findings || object.findings.length === 0) {
      return null;
    }

    return {
      title: object.title,
      findings: object.findings as Finding[],
      phases: object.phases as PhaseDefinition[],
      priorityGroups: object.priorityGroups as PriorityGroup[],
    };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      { err: error },
      'AI document parsing failed — will return empty parse result',
    );
    return null;
  }
}
