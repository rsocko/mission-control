import 'server-only';

import { generateObject } from 'ai';
import { z } from 'zod';
import { getAIModel } from '@/lib/ai/provider-factory';
import {
  IDEATION_EXPAND_MAX_CONTEXT_NODES,
  IDEATION_EXPAND_MAX_PROPOSALS,
  IDEATION_EXPAND_MIN_PROPOSALS,
  normalizeIdeationLabel,
  type IdeationExpansionProposal,
} from '@/lib/graph/ideation-expand';

const nodeKindSchema = z.enum(['idea', 'phase', 'task']);

export const ideationExpansionRequestSchema = z.object({
  selectedNode: z.object({
    id: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(160),
    kind: nodeKindSchema,
    parentId: z.string().trim().min(1).max(128).nullable(),
  }).strict(),
  contextNodes: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(160),
    kind: nodeKindSchema,
    parentId: z.string().trim().min(1).max(128).nullable(),
    sortOrder: z.number().int().min(0).max(10_000),
  }).strict()).min(1).max(IDEATION_EXPAND_MAX_CONTEXT_NODES),
  contextVersion: z.string().min(1).max(64),
}).strict().superRefine((value, context) => {
  if (!value.contextNodes.some((node) => node.id === value.selectedNode.id)) {
    context.addIssue({
      code: 'custom',
      path: ['contextNodes'],
      message: 'Selected node must be present in context',
    });
  }
});

const modelOutputSchema = z.object({
  proposals: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    rationale: z.string().trim().min(1).max(280),
  }).strict()).min(IDEATION_EXPAND_MIN_PROPOSALS).max(IDEATION_EXPAND_MAX_PROPOSALS),
}).strict();

export class InvalidIdeationExpansionError extends Error {
  constructor(message = 'AI returned invalid or insufficient proposals') {
    super(message);
    this.name = 'InvalidIdeationExpansionError';
  }
}

export function normalizeIdeationExpansionOutput(
  raw: unknown,
  existingLabels: string[],
): IdeationExpansionProposal[] {
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidIdeationExpansionError();

  const usedLabels = new Set(existingLabels.map(normalizeIdeationLabel));
  const proposals: IdeationExpansionProposal[] = [];

  for (const candidate of parsed.data.proposals) {
    const label = candidate.label.trim().replace(/\s+/g, ' ');
    const normalized = normalizeIdeationLabel(label);
    if (!normalized || usedLabels.has(normalized)) continue;
    usedLabels.add(normalized);
    proposals.push({
      id: crypto.randomUUID(),
      label,
      rationale: candidate.rationale.trim().replace(/\s+/g, ' '),
    });
  }

  if (proposals.length < IDEATION_EXPAND_MIN_PROPOSALS) {
    throw new InvalidIdeationExpansionError();
  }

  return proposals.slice(0, IDEATION_EXPAND_MAX_PROPOSALS);
}

export async function generateIdeationExpansion(
  input: z.infer<typeof ideationExpansionRequestSchema>,
  abortSignal?: AbortSignal,
): Promise<IdeationExpansionProposal[]> {
  const route = getAIModel('ideation-expansion');
  const selectedChildren = input.contextNodes.filter((node) => node.parentId === input.selectedNode.id);
  const context = input.contextNodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    parentId: node.parentId,
    sortOrder: node.sortOrder,
  }));

  const { object } = await generateObject({
    model: route.model,
    schema: modelOutputSchema,
    maxOutputTokens: 700,
    abortSignal,
    system: `You expand one node in a project ideation tree with useful, non-overlapping child ideas.

Return 3-5 concise proposals. Each proposal must:
- be a direct child concept of the selected node
- add a distinct actionable angle not already represented by an existing child
- use a specific title of at most 120 characters
- include one brief rationale

Do not repeat, rename, or persist existing nodes. Do not return markdown.`,
    prompt: JSON.stringify({
      selectedNode: input.selectedNode,
      existingChildLabels: selectedChildren.map((node) => node.label),
      boundedTreeContext: context,
    }),
  });

  return normalizeIdeationExpansionOutput(
    object,
    selectedChildren.map((node) => node.label),
  );
}
