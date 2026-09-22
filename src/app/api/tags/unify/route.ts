import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { evaluateRulesForTasks } from '@/lib/rules';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
 * The canonicalization, linking, scoped detachment and rename all land inside
 * one persistence transaction that re-validates the selection, so a concurrent
 * tag edit either loses the race cleanly or is rejected — never half applied.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const sourceTagIds = readField(body, 'sourceTagIds');
    const targetTagId = readField(body, 'targetTagId');
    const newName = optionalString(readField(body, 'newName'));
    const newColor = optionalString(readField(body, 'newColor'));

    if (!Array.isArray(sourceTagIds) || sourceTagIds.length === 0) {
      return ApiErrors.badRequest('sourceTagIds must be a non-empty array');
    }
    if (!targetTagId || typeof targetTagId !== 'string') {
      return ApiErrors.badRequest('targetTagId is required');
    }

    // Filter out the target from source IDs and deduplicate
    const tagsToUnify = [...new Set(
      sourceTagIds.filter((id): id is string => typeof id === 'string' && id !== targetTagId),
    )];

    const persistence = await getTaskCorePersistence();
    const organization = persistence.organization;

    const candidates = await organization.getTagConsolidationCandidates({
      targetTagId,
      sourceTagIds: tagsToUnify,
    });
    if (!candidates.target) {
      return ApiErrors.notFound('Target tag');
    }
    if (tagsToUnify.length === 0) {
      return NextResponse.json({ success: true, unified: 0, linked: 0 });
    }
    if (candidates.sources.length !== tagsToUnify.length) {
      return ApiErrors.badRequest('One or more source tags not found');
    }

    const outcome = await organization.unifyTags({
      targetTagId,
      sourceTagIds: tagsToUnify,
      newName,
      newSlug: newName ? slugify(newName) : null,
      newColor,
    });
    if (outcome.kind === 'stale') {
      return ApiErrors.badRequest('The selected tags changed before the merge could be applied');
    }
    if (outcome.kind === 'missing-source-scope') {
      return ApiErrors.badRequest('The selected source tags have no task scope to detach from');
    }

    const { linked: linkedCount, detached: detachedCount, detachedTaskIds } = outcome;
    logger.info(
      { targetTagId, unifiedCount: tagsToUnify.length, linkedCount },
      'Tags unified successfully',
    );

    let affectedTaskIds: string[] = [];
    try {
      affectedTaskIds = [...new Set([
        ...await organization.listTaskIdsForTag(targetTagId),
        ...detachedTaskIds,
      ])];
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
      removed: outcome.targetIsSourceBacked ? 0 : outcome.localTagIds.length,
      detached: detachedCount,
    });
  } catch (error) {
    logger.error({ error }, 'Tag unification failed');
    return ApiErrors.internal('Failed to unify tags', error);
  }
}
