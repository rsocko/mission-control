import { suggestEnergyTags } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import db, { runTransaction } from '@/db';
import { tags, taskTags } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { ApiErrors } from '@/lib/api-error';

const ENERGY_TAG_DEFS: Array<{ slug: string; name: string; color: string }> = [
  { slug: 'energy-high', name: 'Energy: High', color: '#10b981' },
  { slug: 'energy-medium', name: 'Energy: Medium', color: '#f59e0b' },
  { slug: 'energy-low', name: 'Energy: Low', color: '#ef4444' },
];

/**
 * Ensure the three energy tags exist in the tags table.
 * Uses a transaction with insert-or-ignore to avoid TOCTOU races.
 * Returns a map of slug → tag ID.
 */
async function ensureEnergyTags(): Promise<Map<string, string>> {
  const now = new Date().toISOString();

  runTransaction((tx) => {
    for (const def of ENERGY_TAG_DEFS) {
      const existing = tx.select({ id: tags.id })
        .from(tags)
        .where(eq(tags.slug, def.slug))
        .limit(1)
        .all();

      if (existing.length === 0) {
        tx.insert(tags).values({
          id: `tag-${def.slug}-${randomUUID().slice(0, 8)}`,
          name: def.name,
          slug: def.slug,
          type: 'ai-inferred',
          source: 'energy-system',
          color: def.color,
          confirmed: true,
          createdAt: now,
        }).run();
      }
    }
  });

  // Re-read after transaction to get canonical IDs
  const slugs = ENERGY_TAG_DEFS.map(d => d.slug);
  const existing = await db.select({ id: tags.id, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, slugs));

  return new Map(existing.map(t => [t.slug, t.id]));
}

/**
 * POST /api/ai/suggest-energy-tags
 * AI infers energy demand for tasks and optionally auto-applies the tags.
 *
 * Body: { taskIds?: string[], autoApply?: boolean }
 * - taskIds: specific tasks to classify (omit for all untagged open tasks)
 * - autoApply: if true, automatically add the energy tags to tasks (default: false)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const taskIds: string[] | undefined = body.taskIds;
    const autoApply = body.autoApply === true;

    const result = await suggestEnergyTags(taskIds);

    if (autoApply && result.suggestions.length > 0) {
      const slugToId = await ensureEnergyTags();
      const energyTagIds = [...slugToId.values()];
      const suggestionTaskIds = result.suggestions.map(s => s.taskId);

      // Batch: fetch all existing energy tag assignments for these tasks
      const existingAssignments = await db.select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
        .from(taskTags)
        .where(and(
          inArray(taskTags.taskId, suggestionTaskIds),
          inArray(taskTags.tagId, energyTagIds),
        ));

      const tasksWithEnergyTag = new Set(existingAssignments.map(a => a.taskId));

      // Batch: collect all new assignments, then insert at once
      const newAssignments = result.suggestions
        .filter(s => !tasksWithEnergyTag.has(s.taskId))
        .map(s => {
          const tagId = slugToId.get(`energy-${s.energyLevel}`);
          return tagId ? { taskId: s.taskId, tagId } : null;
        })
        .filter((a): a is { taskId: string; tagId: string } => a !== null);

      if (newAssignments.length > 0) {
        await db.insert(taskTags).values(newAssignments);
      }
    }

    return Response.json({
      suggestions: result.suggestions,
      applied: autoApply,
      generatedAt: new Date().toISOString(),
      routing: result.routing,
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Energy tag inference failed');
    return ApiErrors.internal('Failed', error);
  }
}
