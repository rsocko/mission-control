import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { evaluateRulesForTasks } from '@/lib/rules';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';

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
 * POST /api/tags/merge — Merge multiple tags into a single target tag.
 *
 * Body: {
 *   sourceTagIds: string[],   // Tags to merge away (will be deleted)
 *   targetTagId: string,      // Tag to merge into (must exist or be in sourceTagIds)
 *   newName?: string,         // Optional: rename the target tag
 *   newColor?: string,        // Optional: recolor the target tag
 * }
 *
 * The reassignment, deletion and rename all land inside one persistence
 * transaction that re-validates the selection, so a concurrent tag edit either
 * loses the race cleanly or is rejected — never half applied.
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
    const tagsToRemove = [...new Set(
      sourceTagIds.filter((id): id is string => typeof id === 'string' && id !== targetTagId),
    )];

    const persistence = await getTaskCorePersistence();
    const organization = persistence.organization;

    const candidates = await organization.getTagConsolidationCandidates({
      targetTagId,
      sourceTagIds: tagsToRemove,
    });
    if (!candidates.target) {
      return ApiErrors.notFound('Target tag');
    }
    if (tagsToRemove.length === 0) {
      return NextResponse.json({ success: true, merged: 0, reassigned: 0 });
    }
    if (candidates.sources.length !== tagsToRemove.length) {
      return ApiErrors.badRequest('One or more source tags not found');
    }
    if (
      candidates.target.type === 'source'
      || candidates.sources.some((tag) => tag.type === 'source')
    ) {
      return ApiErrors.badRequest('Source-backed tags must be merged with the source-safe tag merge');
    }

    const outcome = await organization.mergeTags({
      targetTagId,
      sourceTagIds: tagsToRemove,
      newName,
      newSlug: newName ? slugify(newName) : null,
      newColor,
    });
    if (outcome.kind === 'stale') {
      return ApiErrors.badRequest('The selected tags changed before the merge could be applied');
    }
    if (outcome.kind === 'source-backed') {
      return ApiErrors.badRequest('Source-backed tags must be merged with the source-safe tag merge');
    }

    const reassignedCount = outcome.reassigned;
    logger.info(
      { targetTagId, mergedCount: tagsToRemove.length, reassignedCount },
      'Tags merged successfully',
    );

    let affectedTaskIds: string[] = [];
    try {
      affectedTaskIds = await organization.listTaskIdsForTag(targetTagId);
      await evaluateRulesForTasks(affectedTaskIds);
    } catch (error) {
      logger.error({ error, targetTagId }, 'Project auto-include evaluation failed after tag merge');
    }
    await Promise.all([
      publishSemanticEntityUpsert('tag', targetTagId),
      ...tagsToRemove.map((id) => publishSemanticEntityDelete('tag', id)),
      ...affectedTaskIds.map((id) => publishSemanticEntityUpsert('task', id)),
    ]);

    return NextResponse.json({
      success: true,
      merged: tagsToRemove.length,
      reassigned: reassignedCount,
    });
  } catch (error) {
    logger.error({ error }, 'Tag merge failed');
    return ApiErrors.internal('Failed to merge tags', error);
  }
}
