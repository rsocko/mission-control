import { z } from 'zod';
import { createHash } from 'crypto';

export const MAX_BREAKDOWN_SUBTASKS = 8;

export const aiBreakdownOutputSchema = z.object({
  subtasks: z.array(z.object({
    title: z.string().min(1).max(160),
    description: z.string().max(600).optional().default(''),
    effort: z.number().int().min(1).max(5).nullable().optional().default(null),
  }).strict()).min(1).max(MAX_BREAKDOWN_SUBTASKS),
}).strict();

export type AiBreakdownOutput = z.infer<typeof aiBreakdownOutputSchema>;

export interface BreakdownProposal {
  id: string;
  title: string;
  description: string;
  effort: number | null;
}

function normalizeTitle(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function titleKey(value: string) {
  return normalizeTitle(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizeBreakdownProposals(
  output: unknown,
  existingTitles: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
): BreakdownProposal[] {
  const parsed = aiBreakdownOutputSchema.safeParse(output);
  if (!parsed.success) {
    return [];
  }

  const seen = new Set(existingTitles.map(titleKey).filter(Boolean));
  const proposals: BreakdownProposal[] = [];

  for (const candidate of parsed.data.subtasks) {
    const title = normalizeTitle(candidate.title);
    const key = titleKey(title);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    proposals.push({
      id: createId(),
      title,
      description: candidate.description.trim().slice(0, 600),
      effort: candidate.effort ?? null,
    });

    if (proposals.length === MAX_BREAKDOWN_SUBTASKS) {
      break;
    }
  }

  return proposals;
}

interface BreakdownPromptTask {
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  effort: number | null;
  sourceListName: string | null;
  tags: readonly string[];
  projects: readonly string[];
  existingSubtasks: readonly string[];
}

function bounded(value: string | null, maxLength: number) {
  return value?.trim().slice(0, maxLength) || 'None';
}

function boundedList(values: readonly string[], count: number, maxItemLength: number) {
  return values
    .slice(0, count)
    .map((value) => value.trim().slice(0, maxItemLength))
    .filter(Boolean);
}

export function createBreakdownContextVersion(input: {
  updatedAt: string;
  tags: readonly string[];
  projects: readonly string[];
  existingSubtasks: readonly string[];
}) {
  const context = {
    updatedAt: input.updatedAt,
    tags: boundedList(input.tags, 20, 100).sort(),
    projects: boundedList(input.projects, 10, 200).sort(),
    existingSubtasks: boundedList(input.existingSubtasks, 30, 200).sort(),
  };
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export function buildBreakdownPrompt(task: BreakdownPromptTask) {
  const tags = boundedList(task.tags, 20, 100);
  const projects = boundedList(task.projects, 10, 200);
  const existing = boundedList(task.existingSubtasks, 30, 200);
  const prompt = [
    'Break this existing task into concrete, independently actionable subtasks.',
    'Return 3-8 useful subtasks, ordered by execution sequence.',
    'Do not repeat existing subtasks, restate the parent task, or add generic project-management filler.',
    'Use concise imperative titles. Include a short description only when it adds implementation detail.',
    'Effort is an integer from 1 (small) to 5 (large), or null when genuinely unknown.',
    '',
    `Title: ${bounded(task.title, 200)}`,
    `Description: ${bounded(task.description, 3000)}`,
    `Priority: ${bounded(task.priority, 40)}`,
    `Due date: ${bounded(task.dueDate, 40)}`,
    `Parent effort: ${task.effort ?? 'None'}`,
    `List: ${bounded(task.sourceListName, 200)}`,
    `Tags: ${tags.join(', ') || 'None'}`,
    `Projects: ${projects.join(', ') || 'None'}`,
    `Existing subtasks: ${existing.join(' | ') || 'None'}`,
  ].join('\n');
  return prompt.slice(0, 10_000);
}
