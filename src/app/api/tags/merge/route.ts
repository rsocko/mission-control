import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tags, taskTags } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { evaluateRulesForTasks } from '@/lib/rules';

class TagMergeInputError extends Error {}

/**
 * POST /api/tags/merge — Merge multiple tags into a single target tag.
 *
 * Body: {
 *   sourceTagIds: string[],   // Tags to merge away (will be deleted)
 *   targetTagId: string,      // Tag to merge into (must exist or be in sourceTagIds)
 *   newName?: string,         // Optional: rename the target tag
 *   newColor?: string,        // Optional: recolor the target tag
 * }
 *
 * Steps:
 * 1. Re-assign all taskTags from source tags → target tag
 * 2. Remove duplicate taskTag rows (same task, same target tag)
 * 3. Delete the source tags (except the target)
 * 4. Optionally rename/recolor the target
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sourceTagIds, targetTagId, newName, newColor } = body;

    if (!Array.isArray(sourceTagIds) || sourceTagIds.length === 0) {
      return ApiErrors.badRequest('sourceTagIds must be a non-empty array');
    }
    if (!targetTagId || typeof targetTagId !== 'string') {
      return ApiErrors.badRequest('targetTagId is required');
    }

    // Verify target tag exists
    const [targetTag] = await db.select().from(tags).where(eq(tags.id, targetTagId)).limit(1);
    if (!targetTag) {
      return ApiErrors.notFound('Target tag');
    }

    // Filter out the target from source IDs and deduplicate
    const tagsToRemove = [...new Set(sourceTagIds.filter((id: string) => id !== targetTagId))];

    if (tagsToRemove.length === 0) {
      return NextResponse.json({ success: true, merged: 0, reassigned: 0 });
    }

    // Verify all source tags exist
    const sourceTags = tagsToRemove.length > 0
      ? await db.select({ id: tags.id, name: tags.name, type: tags.type }).from(tags).where(inArray(tags.id, tagsToRemove))
      : [];

    if (sourceTags.length !== tagsToRemove.length) {
      return ApiErrors.badRequest('One or more source tags not found');
    }
    if (targetTag.type === 'source' || sourceTags.some(tag => tag.type === 'source')) {
      return ApiErrors.badRequest('Source-backed tags must be merged with the source-safe tag merge');
    }

    let reassignedCount = 0;

    runTransaction((tx) => {
      const currentTarget = tx.select({ id: tags.id, type: tags.type })
        .from(tags)
        .where(eq(tags.id, targetTagId))
        .get();
      const currentSourceTags = tx.select({ id: tags.id, type: tags.type })
        .from(tags)
        .where(inArray(tags.id, tagsToRemove))
        .all();
      if (!currentTarget || currentSourceTags.length !== tagsToRemove.length) {
        throw new TagMergeInputError('The selected tags changed before the merge could be applied');
      }
      if (currentTarget.type === 'source' || currentSourceTags.some(tag => tag.type === 'source')) {
        throw new TagMergeInputError('Source-backed tags must be merged with the source-safe tag merge');
      }

      const allTagAliases = tx.select({
        id: tags.id,
        unifiedInto: tags.unifiedInto,
      }).from(tags).all();
      const aliasesById = new Map(allTagAliases.map(tag => [tag.id, tag]));
      const consolidationRoots = new Set([...tagsToRemove, targetTagId]);
      const aliasTagIds = allTagAliases.flatMap(tag => {
        if (tag.id === targetTagId || !tag.unifiedInto) return [];
        const visited = new Set<string>([tag.id]);
        let currentId: string | null = tag.unifiedInto;
        while (currentId && !visited.has(currentId)) {
          if (consolidationRoots.has(currentId)) return [tag.id];
          visited.add(currentId);
          currentId = aliasesById.get(currentId)?.unifiedInto ?? null;
        }
        return [];
      });
      tx.update(tags)
        .set({ unifiedInto: null })
        .where(eq(tags.id, targetTagId))
        .run();
      if (aliasTagIds.length > 0) {
        tx.update(tags)
          .set({ unifiedInto: targetTagId })
          .where(inArray(tags.id, aliasTagIds))
          .run();
      }

      // Get all taskTag rows for source tags
      const taskSourceTagIds = [...new Set([...tagsToRemove, ...aliasTagIds])];
      const sourceTaskTags = tx
        .select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
        .from(taskTags)
        .where(inArray(taskTags.tagId, taskSourceTagIds))
        .all();

      // Get existing task→target mappings to avoid duplicates
      const existingTargetLinks = new Set(
        tx.select({ taskId: taskTags.taskId })
          .from(taskTags)
          .where(eq(taskTags.tagId, targetTagId))
          .all()
          .map(r => r.taskId),
      );

      // Re-assign: for each source task, link to target if not already linked
      const toInsert = sourceTaskTags
        .filter(row => !existingTargetLinks.has(row.taskId))
        .map(row => row.taskId);
      // Deduplicate task IDs
      const uniqueTaskIds = [...new Set(toInsert)];

      if (uniqueTaskIds.length > 0) {
        tx.insert(taskTags)
          .values(uniqueTaskIds.map(taskId => ({ taskId, tagId: targetTagId })))
          .run();
        reassignedCount = uniqueTaskIds.length;
      }

      // Delete all task-tag links for source tags
      tx.delete(taskTags).where(inArray(taskTags.tagId, tagsToRemove)).run();

      // Delete the source tags themselves
      tx.delete(tags).where(inArray(tags.id, tagsToRemove)).run();

      // Optionally update the target tag's name/color
      const updates: Record<string, unknown> = {};
      if (newName) {
        updates.name = newName;
        updates.slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      if (newColor) updates.color = newColor;
      if (Object.keys(updates).length > 0) {
        tx.update(tags).set(updates).where(eq(tags.id, targetTagId)).run();
      }
    });

    logger.info(
      { targetTagId, mergedCount: tagsToRemove.length, reassignedCount },
      'Tags merged successfully',
    );

    try {
      const affectedTaskIds = await db.select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(eq(taskTags.tagId, targetTagId));
      await evaluateRulesForTasks(affectedTaskIds.map((row) => row.taskId));
    } catch (error) {
      logger.error({ error, targetTagId }, 'Project auto-include evaluation failed after tag merge');
    }

    return NextResponse.json({
      success: true,
      merged: tagsToRemove.length,
      reassigned: reassignedCount,
    });
  } catch (error) {
    if (error instanceof TagMergeInputError) {
      return ApiErrors.badRequest(error.message);
    }
    logger.error({ error }, 'Tag merge failed');
    return ApiErrors.internal('Failed to merge tags', error);
  }
}
