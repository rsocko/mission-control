import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tags, taskTags, tasks } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { evaluateRulesForTasks } from '@/lib/rules';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication';

class TagUnifyInputError extends Error {}

/**
 * POST /api/tags/unify — Unify source tags under a single hub tag.
 *
 * Unlike merge (which deletes every non-target tag), unify preserves
 * source-backed tags so future syncs can still identify them. When a source
 * tag is the target, local tags are detached only from that source's scope.
 *
 * Body: {
 *   sourceTagIds: string[],   // Source tags to unify
 *   targetTagId: string,      // Hub tag to unify into (or one of the source tags)
 *   newName?: string,         // Optional: rename the target tag
 *   newColor?: string,        // Optional: recolor the target tag
 * }
 *
 * Steps:
 * 1. Ensure the target tag exists (or create a hub tag if needed)
 * 2. Set unified_into on each non-target source tag → target
 * 3. Link all tasks from source tags to the target tag (additive, no deletions)
 * 4. Delete redundant local tags, or detach them from a source target's scope
 * 5. Optionally rename/recolor the target
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
    const tagsToUnify = [...new Set(sourceTagIds.filter((id: string) => id !== targetTagId))];

    if (tagsToUnify.length === 0) {
      return NextResponse.json({ success: true, unified: 0, linked: 0 });
    }

    // Verify all source tags exist
    const sourceTags = await db
      .select({ id: tags.id, name: tags.name, type: tags.type })
      .from(tags)
      .where(inArray(tags.id, tagsToUnify));

    if (sourceTags.length !== tagsToUnify.length) {
      return ApiErrors.badRequest('One or more source tags not found');
    }

    let sourceBackedTagIds: string[] = [];
    let localTagIds: string[] = [];
    let linkedCount = 0;
    let detachedCount = 0;
    let detachedTaskIds: string[] = [];
    let targetIsSourceBacked = targetTag.type === 'source';

    runTransaction((tx) => {
      const currentTarget = tx.select({ id: tags.id, type: tags.type })
        .from(tags)
        .where(eq(tags.id, targetTagId))
        .get();
      const currentSourceTags = tx.select({ id: tags.id, type: tags.type })
        .from(tags)
        .where(inArray(tags.id, tagsToUnify))
        .all();
      if (!currentTarget || currentSourceTags.length !== tagsToUnify.length) {
        throw new TagUnifyInputError('The selected tags changed before the merge could be applied');
      }

      targetIsSourceBacked = currentTarget.type === 'source';
      sourceBackedTagIds = currentSourceTags
        .filter(tag => tag.type === 'source')
        .map(tag => tag.id);
      localTagIds = currentSourceTags
        .filter(tag => tag.type !== 'source')
        .map(tag => tag.id);
      const globallyConsolidatedTagIds = targetIsSourceBacked
        ? sourceBackedTagIds
        : tagsToUnify;
      const allTagAliases = tx.select({
        id: tags.id,
        type: tags.type,
        unifiedInto: tags.unifiedInto,
      }).from(tags).all();
      const aliasesById = new Map(allTagAliases.map(tag => [tag.id, tag]));
      const consolidationRoots = new Set([...globallyConsolidatedTagIds, targetTagId]);
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
      const tagsToCanonicalize = [...new Set([
        ...globallyConsolidatedTagIds,
        ...aliasTagIds,
      ].filter(id => id !== targetTagId))];
      const selectedSourceTagIds = new Set([
        targetTagId,
        ...tagsToCanonicalize.filter(id => aliasesById.get(id)?.type === 'source'),
      ]);
      const selectedSourceScopeKeys = new Set(
        tx.select({
          connectorInstanceId: tasks.connectorInstanceId,
          sourceListId: tasks.sourceListId,
        })
          .from(taskTags)
          .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
          .where(inArray(taskTags.tagId, [...selectedSourceTagIds]))
          .all()
          .map(row => `${row.connectorInstanceId}\u0000${row.sourceListId ?? ''}`),
      );
      if (targetIsSourceBacked && localTagIds.length > 0 && selectedSourceScopeKeys.size === 0) {
        throw new TagUnifyInputError('The selected source tags have no task scope to detach from');
      }
      tx.update(tags)
        .set({ unifiedInto: null })
        .where(eq(tags.id, targetTagId))
        .run();
      if (tagsToCanonicalize.length > 0) {
        tx.update(tags)
          .set({ unifiedInto: targetTagId })
          .where(inArray(tags.id, tagsToCanonicalize))
          .run();
      }

      // A source winner represents only its own connector/list scopes. Shared
      // local tags must remain available to every other source.
      const taskSourceTagIds = [...new Set([...tagsToUnify, ...aliasTagIds])];
      const sourceTaskTags = tx
        .select({
          taskId: taskTags.taskId,
          tagId: taskTags.tagId,
          connectorInstanceId: tasks.connectorInstanceId,
          sourceListId: tasks.sourceListId,
        })
        .from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .where(inArray(taskTags.tagId, taskSourceTagIds))
        .all();

      // Get existing task→target links to avoid duplicates
      const existingTargetLinks = new Set(
        tx.select({ taskId: taskTags.taskId })
          .from(taskTags)
          .where(eq(taskTags.tagId, targetTagId))
          .all()
          .map(r => r.taskId),
      );

      // Link tasks to the target tag (additive — don't remove source tag links)
      const uniqueTaskIds = [...new Set(
        sourceTaskTags
          .filter(row => !targetIsSourceBacked || tagsToCanonicalize.includes(row.tagId))
          .map(r => r.taskId)
          .filter(taskId => !existingTargetLinks.has(taskId)),
      )];

      if (uniqueTaskIds.length > 0) {
        tx.insert(taskTags)
          .values(uniqueTaskIds.map(taskId => ({ taskId, tagId: targetTagId })))
          .run();
        linkedCount = uniqueTaskIds.length;
      }

      if (localTagIds.length > 0) {
        if (targetIsSourceBacked) {
          const sourceBackedTaskIds = new Set(
            sourceTaskTags
              .filter(row => selectedSourceTagIds.has(row.tagId))
              .map(row => row.taskId),
          );
          const scopedTaskIds = [...new Set(
            sourceTaskTags
              .filter(row =>
                localTagIds.includes(row.tagId)
                && selectedSourceScopeKeys.has(`${row.connectorInstanceId}\u0000${row.sourceListId ?? ''}`)
                && (existingTargetLinks.has(row.taskId) || sourceBackedTaskIds.has(row.taskId))
              )
              .map(row => row.taskId),
          )];
          if (scopedTaskIds.length > 0) {
            const result = tx.delete(taskTags)
              .where(and(
                inArray(taskTags.tagId, localTagIds),
                inArray(taskTags.taskId, scopedTaskIds),
              ))
              .run();
            detachedCount = result.changes;
            detachedTaskIds = scopedTaskIds;
          }
        } else {
          tx.delete(taskTags).where(inArray(taskTags.tagId, localTagIds)).run();
          tx.delete(tags).where(inArray(tags.id, localTagIds)).run();
        }
      }

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
      { targetTagId, unifiedCount: tagsToUnify.length, linkedCount },
      'Tags unified successfully',
    );

    let affectedTaskIds: string[] = [];
    try {
      const affectedTasks = await db.select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(eq(taskTags.tagId, targetTagId));
      affectedTaskIds = [
        ...new Set([
          ...affectedTasks.map((row) => row.taskId),
          ...detachedTaskIds,
        ]),
      ];
      await evaluateRulesForTasks([
        ...affectedTaskIds,
      ]);
    } catch (error) {
      logger.error({ error, targetTagId }, 'Project auto-include evaluation failed after tag unification');
    }
    await Promise.all([
      ...[...new Set([targetTagId, ...tagsToUnify])]
        .map((id) => publishSemanticEntityUpsert('tag', id)),
      ...affectedTaskIds.map((id) => publishSemanticEntityUpsert('task', id)),
    ]);

    return NextResponse.json({
      success: true,
      unified: tagsToUnify.length,
      linked: linkedCount,
      removed: targetIsSourceBacked ? 0 : localTagIds.length,
      detached: detachedCount,
    });
  } catch (error) {
    if (error instanceof TagUnifyInputError) {
      return ApiErrors.badRequest(error.message);
    }
    logger.error({ error }, 'Tag unification failed');
    return ApiErrors.internal('Failed to unify tags', error);
  }
}
