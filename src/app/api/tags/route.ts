import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
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

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * GET /api/tags — List all tags with usage counts
 * Query params: ?type=source|hub|ai-inferred&source=github-issues&listId=<sourceListId>&includeListUsage=true
 *
 * When `listId` is provided, only returns tags that are used by tasks
 * belonging to that source list (useful for per-list tag scoping like GitHub labels).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const source = searchParams.get('source');
  const listId = searchParams.get('listId');
  const includeListUsage = searchParams.get('includeListUsage') === 'true';

  try {
    const persistence = await getTaskCorePersistence();
    const overview = await persistence.organization.readTagOverview({
      type,
      source,
      listId,
      includeUsageBreakdown: includeListUsage,
    });
    return NextResponse.json({
      tags: overview.tags,
      sourceTagSlugs: overview.sourceTagSlugs,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch tags', error);
  }
}

/**
 * POST /api/tags — Create a new hub tag
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const name = readField(body, 'name');
    const rawColor = readField(body, 'color');

    if (typeof name !== 'string' || !name) {
      return ApiErrors.badRequest('Tag name is required');
    }

    const color = typeof rawColor === 'string' && rawColor ? rawColor : '#6b7280';
    const slug = slugify(name);
    const id = `tag-${slug}`;
    const now = new Date().toISOString();

    // The slug check and the insert are one atomic step, so a concurrent
    // create resolves to the same tag instead of racing to a duplicate.
    const persistence = await getTaskCorePersistence();
    const outcome = await persistence.organization.createHubTag({
      id,
      name,
      slug,
      color,
      createdAt: now,
    });

    if (outcome.kind === 'existing') {
      const existing = outcome.tag;
      return NextResponse.json({
        id: existing.id,
        name: existing.name,
        slug: existing.slug,
        type: existing.type,
        color: existing.color,
      }, { status: 200 });
    }

    await publishSemanticEntityUpsert('tag', id);
    return NextResponse.json({ id, name, slug, type: 'hub', color }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create tag', error);
  }
}

/**
 * PATCH /api/tags — Update a tag (color, name, confirm AI tag)
 */
export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json();
    const tagId = readField(body, 'id');
    const name = readField(body, 'name');
    const color = readField(body, 'color');
    const confirmed = readField(body, 'confirmed');

    if (typeof tagId !== 'string' || !tagId) {
      return ApiErrors.badRequest('Tag id is required');
    }
    if (name !== undefined && typeof name !== 'string') {
      return ApiErrors.badRequest('Tag name must be a string');
    }
    if (color !== undefined && typeof color !== 'string') {
      return ApiErrors.badRequest('Tag color must be a string');
    }
    if (confirmed !== undefined && typeof confirmed !== 'boolean') {
      return ApiErrors.badRequest('Tag confirmed must be a boolean');
    }

    const persistence = await getTaskCorePersistence();
    const { affectedTaskIds } = await persistence.organization.updateTag({
      tagId,
      ...(name !== undefined ? { name, slug: slugify(name) } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(confirmed !== undefined ? { confirmed } : {}),
    });

    await Promise.all([
      publishSemanticEntityUpsert('tag', tagId),
      ...affectedTaskIds.map((taskId) => publishSemanticEntityUpsert('task', taskId)),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update tag', error);
  }
}

/**
 * DELETE /api/tags — Delete a hub tag (cannot delete source tags)
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const tagId = searchParams.get('id');

  if (!tagId) {
    return ApiErrors.badRequest('Tag id is required');
  }

  try {
    const persistence = await getTaskCorePersistence();
    const outcome = await persistence.organization.deleteHubTag(tagId);
    if (outcome.kind === 'missing') {
      return ApiErrors.notFound('Tag');
    }
    if (outcome.kind === 'source-managed') {
      return ApiErrors.forbidden('Cannot delete source tags — they are managed by the connector');
    }

    await Promise.all([
      publishSemanticEntityDelete('tag', tagId),
      ...outcome.affectedTaskIds.map((taskId) => publishSemanticEntityUpsert('task', taskId)),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete tag', error);
  }
}
