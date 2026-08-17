import { z } from 'zod';
import { normalizeAutoIncludeRules } from '@/lib/rules';

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const nullableTextSchema = z.string().max(10_000).nullable();

const sourceBindingSchema = z.object({
  connectorInstanceId: z.string().trim().min(1),
  sourceListId: z.string().trim().min(1).nullable().optional(),
  defaultSourceListId: z.string().trim().min(1).nullable().optional(),
  filter: z.string().max(4_000).nullable().optional(),
});

const kanbanColumnSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  color: colorSchema,
  order: z.number().finite().optional(),
  statusMapping: z.array(z.string()).optional(),
  globalColumnMapping: z.string().optional(),
  wipLimit: z.number().int().nonnegative().optional(),
});

export const hubProjectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  description: nullableTextSchema.optional(),
  color: colorSchema.optional(),
  icon: z.string().trim().min(1).max(100).nullable().optional(),
  iconColor: colorSchema.nullable().optional(),
  sourceBindings: z.array(sourceBindingSchema).optional(),
  autoIncludeRules: z.array(z.unknown()).optional(),
  kanbanColumns: z.array(kanbanColumnSchema).optional(),
  defaultView: z.string().trim().min(1).max(50).optional(),
  defaultFilters: z.record(z.string(), z.unknown()).nullable().optional(),
  statusOverride: z.enum([
    'not_started',
    'active',
    'on_hold',
    'completed',
    'cancelled',
  ]).nullable().optional(),
  hidden: z.boolean().optional(),
  category: z.string().trim().max(500).nullable().optional(),
  targetDate: z.iso.date().nullable().optional(),
  sortOrder: z.number().finite().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type HubProjectUpdate = z.infer<typeof hubProjectUpdateSchema>;

export type HubProjectUpdateParseResult =
  | { success: true; updates: HubProjectUpdate }
  | { success: false; message: string };

export function parseHubProjectUpdate(value: unknown): HubProjectUpdateParseResult {
  const parsed = hubProjectUpdateSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message || 'Invalid project updates',
    };
  }
  if (Object.keys(parsed.data).length === 0) {
    return { success: false, message: 'No valid fields to update' };
  }

  return {
    success: true,
    updates: {
      ...parsed.data,
      ...('autoIncludeRules' in parsed.data
        ? { autoIncludeRules: normalizeAutoIncludeRules(parsed.data.autoIncludeRules) }
        : {}),
    },
  };
}

export function hubProjectRulesChanged(updates: HubProjectUpdate) {
  return 'autoIncludeRules' in updates || 'sourceBindings' in updates;
}
