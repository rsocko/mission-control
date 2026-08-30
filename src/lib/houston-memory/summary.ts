import { generateObject } from 'ai';
import { z } from 'zod';
import { getAIModel } from '@/lib/ai/provider-factory';
import { getSemanticSourcePort } from '@/lib/semantic-index/source/facade';
import type { SemanticSourceRecord } from '@/lib/semantic-index/source/contracts';
import type { HoustonMemoryEntityLink, HoustonMemoryEntityType } from './contracts';

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;

export const houstonSummaryCaptureSchema = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_MESSAGE_CHARS),
  })).min(2).max(MAX_MESSAGES),
}).strict();

const modelSummarySchema = z.object({
  version: z.literal(1),
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()),
  commitments: z.array(z.string()),
  topics: z.array(z.string()),
  linkedEntities: z.array(z.object({
    type: z.enum(['task', 'project', 'tag']),
    id: z.string(),
  })),
}).strict();

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/gi,
  /\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b/gi,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/g,
  /(?:^|\s)(?:"[^"]{12,}"|“[^”]{12,}”)(?=\s|$|[.,;:!?])/g,
];

function minimizeText(value: string, max: number): string {
  let minimized = value.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) minimized = minimized.replace(pattern, '[redacted]');
  return minimized.slice(0, max).trim();
}

function minimizeList(values: string[], count: number, chars: number): string[] {
  return [...new Set(values.map((value) => minimizeText(value, chars)).filter(Boolean))].slice(0, count);
}

function sourceLabel(source: SemanticSourceRecord | null): string | null {
  if (!source) return null;
  if (source.entityType === 'task') return minimizeText(source.title, 160);
  if (source.entityType === 'project' || source.entityType === 'tag') return minimizeText(source.name, 160);
  return null;
}

async function validateLinks(
  links: Array<{ type: HoustonMemoryEntityType; id: string }>,
): Promise<HoustonMemoryEntityLink[]> {
  const source = await getSemanticSourcePort();
  const unique = links
    .filter((link, index, all) => all.findIndex((other) => (
      other.type === link.type && other.id === link.id
    )) === index)
    .slice(0, 12);
  const validated = await Promise.all(unique.map(async (link) => {
    const record = await source.get(link.type, link.id);
    const label = sourceLabel(record);
    return label ? { ...link, label } : null;
  }));
  return validated.filter((link): link is HoustonMemoryEntityLink => link !== null);
}

export interface MinimizedHoustonSummary {
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  linkedEntities: HoustonMemoryEntityLink[];
}

export async function generateMinimizedHoustonSummary(
  input: z.infer<typeof houstonSummaryCaptureSchema>,
): Promise<MinimizedHoustonSummary> {
  const route = getAIModel('houston-chat', { sensitivityOverride: 'restricted' });
  const { object } = await generateObject({
    model: route.model,
    schema: modelSummarySchema,
    maxOutputTokens: 1_200,
    system: `Create a privacy-minimized durable memory of a Houston conversation.

Return version 1. Preserve only information useful in a future conversation:
- a short title and summary
- durable decisions and explicit future commitments
- a few named topics
- task, project, or tag IDs only when the conversation explicitly identifies them

Never reproduce message text, quotations, credentials, secrets, tool output, hidden reasoning, or transient chatter. Do not infer IDs or decisions. Empty arrays are valid.`,
    prompt: JSON.stringify({ messages: input.messages }),
  });

  return {
    title: minimizeText(object.title, 160) || 'Houston conversation',
    summary: minimizeText(object.summary, 1_500),
    decisions: minimizeList(object.decisions, 10, 300),
    commitments: minimizeList(object.commitments, 10, 300),
    topics: minimizeList(object.topics, 12, 80),
    linkedEntities: await validateLinks(object.linkedEntities),
  };
}
