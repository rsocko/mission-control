import { z } from 'zod';
import {
  IDEATION_PRIORITIES,
  IDEATION_STATUSES,
  type IdeationNode,
} from '@/lib/graph/ideation-types';

export const IDEATION_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const IDEATION_WORKSPACE_TYPE = 'ideation' as const;
export const IDEATION_WORKSPACE_MAX_NODES = 500;

const rawValueSchema = z.string().max(2000);
const stringValueSchema = z.string().max(2000);
const stringListSchema = z.array(z.string().trim().min(1).max(500)).max(100);

export const ideationPropertiesSchema = z.object({
  priority: z.object({
    key: z.literal('priority'),
    rawValue: rawValueSchema,
    value: z.enum(IDEATION_PRIORITIES),
  }).optional(),
  status: z.object({
    key: z.literal('status'),
    rawValue: rawValueSchema,
    value: z.enum(IDEATION_STATUSES),
  }).optional(),
  due: z.object({
    key: z.literal('due'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
  effort: z.object({
    key: z.literal('effort'),
    rawValue: rawValueSchema,
    value: z.number().int().min(1).max(5),
  }).optional(),
  tags: z.object({
    key: z.literal('tags'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  assignee: z.object({
    key: z.literal('assignee'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
  'depends-on': z.object({
    key: z.literal('depends-on'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  related: z.object({
    key: z.literal('related'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  notes: z.object({
    key: z.literal('notes'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
}).strict().default({});

export const ideationNodeSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(500),
  kind: z.enum(['idea', 'phase', 'task']),
  parentId: z.string().min(1).max(100).nullable(),
  sortOrder: z.number().finite(),
  properties: ideationPropertiesSchema,
}).strict();

export const ideationWorkspaceDocumentSchema = z.object({
  schemaVersion: z.literal(IDEATION_WORKSPACE_SCHEMA_VERSION),
  type: z.literal(IDEATION_WORKSPACE_TYPE),
  nodes: z.array(ideationNodeSchema).min(1).max(IDEATION_WORKSPACE_MAX_NODES),
}).strict().superRefine((document, context) => {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  if (byId.size !== document.nodes.length) {
    context.addIssue({ code: 'custom', message: 'Ideation node IDs must be unique' });
    return;
  }
  if (document.nodes.filter((node) => node.parentId === null).length !== 1) {
    context.addIssue({ code: 'custom', message: 'Ideation must contain exactly one root node' });
  }
  for (const node of document.nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      context.addIssue({
        code: 'custom',
        message: `Parent node for "${node.label}" does not exist`,
      });
      continue;
    }
    const visited = new Set([node.id]);
    let current = node;
    while (current.parentId) {
      if (visited.has(current.parentId)) {
        context.addIssue({
          code: 'custom',
          message: 'Ideation hierarchy cannot contain cycles',
        });
        break;
      }
      visited.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
  }
});

export type IdeationWorkspaceDocument = z.infer<typeof ideationWorkspaceDocumentSchema>;

export function createIdeationWorkspaceDocument(
  nodes: IdeationNode[],
): IdeationWorkspaceDocument {
  return ideationWorkspaceDocumentSchema.parse({
    schemaVersion: IDEATION_WORKSPACE_SCHEMA_VERSION,
    type: IDEATION_WORKSPACE_TYPE,
    nodes,
  });
}

export function parseLegacyIdeationDraft(value: unknown): IdeationWorkspaceDocument | null {
  if (!value || typeof value !== 'object') return null;
  const persisted = value as { state?: { nodes?: unknown }; nodes?: unknown };
  const nodes = persisted.state?.nodes ?? persisted.nodes;
  const result = ideationWorkspaceDocumentSchema.safeParse({
    schemaVersion: IDEATION_WORKSPACE_SCHEMA_VERSION,
    type: IDEATION_WORKSPACE_TYPE,
    nodes,
  });
  return result.success ? result.data : null;
}
