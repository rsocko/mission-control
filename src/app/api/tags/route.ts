import { NextResponse } from 'next/server';
import db from '@/db';
import { tags, taskTags, tasks } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

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
    const conditions = [];
    if (type) conditions.push(eq(tags.type, type));

    // Scope tags to a connector type. When listId is also provided, the list
    // filter (below) already narrows to the right repo/list, so we use the same
    // broad task-linkage approach for both cases.
    if (source) {
      conditions.push(
        sql`(${tags.source} = ${source} OR ${tags.id} IN (SELECT tt.tag_id FROM task_tags tt JOIN tasks t ON tt.task_id = t.id WHERE t.connector_type = ${source}))`
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Base query for tags — if listId is provided, scope to tags used by tasks in that list
    const listFilter = listId
      ? sql`${tags.id} IN (SELECT tt.tag_id FROM task_tags tt JOIN tasks t ON tt.task_id = t.id WHERE t.source_list_id = ${listId})`
      : undefined;

    const combinedWhere = where && listFilter
      ? and(where, listFilter)
      : where || listFilter || undefined;

    const allTags = await db.select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      createdAt: tags.createdAt,
      unifiedInto: tags.unifiedInto,
      usageCount: sql<number>`(SELECT COUNT(*) FROM task_tags WHERE tag_id = ${tags.id})`,
      // Distinct connector types that contributed this tag (via task linkage)
      sources: sql<string>`(SELECT GROUP_CONCAT(DISTINCT t.connector_type) FROM task_tags tt JOIN tasks t ON tt.task_id = t.id WHERE tt.tag_id = ${tags.id})`,
      // Human-readable repos/lists that use this tag
      sourceNames: sql<string>`(SELECT GROUP_CONCAT(DISTINCT t.source_list_name) FROM task_tags tt JOIN tasks t ON tt.task_id = t.id WHERE tt.tag_id = ${tags.id} AND t.source_list_name IS NOT NULL)`,
    })
      .from(tags)
      .where(combinedWhere)
      .orderBy(tags.type, tags.name);

    const listUsageByTag = new Map<string, Array<{
      tagId: string;
      connectorInstanceId: string;
      sourceListId: string | null;
      usageCount: number;
    }>>();
    const sourceUsageByTag = new Map<string, Array<{
      connectorType: string;
      usageCount: number;
    }>>();
    if (includeListUsage) {
      const sourceUsage = await db.select({
        tagId: taskTags.tagId,
        connectorType: tasks.connectorType,
        usageCount: sql<number>`count(*)`,
      })
        .from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .groupBy(taskTags.tagId, tasks.connectorType);

      for (const usage of sourceUsage) {
        const entries = sourceUsageByTag.get(usage.tagId) ?? [];
        entries.push(usage);
        sourceUsageByTag.set(usage.tagId, entries);
      }

      const listUsage = await db.select({
        tagId: taskTags.tagId,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceListId: tasks.sourceListId,
        usageCount: sql<number>`count(*)`,
      })
        .from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .where(sql`${tasks.sourceListId} IS NOT NULL`)
        .groupBy(taskTags.tagId, tasks.connectorInstanceId, tasks.sourceListId);

      for (const usage of listUsage) {
        const entries = listUsageByTag.get(usage.tagId) ?? [];
        entries.push(usage);
        listUsageByTag.set(usage.tagId, entries);
      }
    }

    // Parse sources into an array for each tag
    const enrichedTags = allTags.map(tag => ({
      ...tag,
      sources: tag.sources ? (tag.sources as string).split(',') : (tag.source ? [tag.source] : []),
      sourceNames: tag.sourceNames ? (tag.sourceNames as string).split(',') : [],
      listUsage: listUsageByTag.get(tag.id) ?? [],
      sourceUsage: sourceUsageByTag.get(tag.id) ?? [],
    }));

    // Collect all source-type tag slugs (always unfiltered) so the UI can
    // accurately identify hub-only tags regardless of query params
    const allSourceSlugs = await db.select({ slug: tags.slug })
      .from(tags)
      .where(eq(tags.type, 'source'));
    const sourceTagSlugs = allSourceSlugs.map(t => t.slug);

    return NextResponse.json({ tags: enrichedTags, sourceTagSlugs });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch tags', error);
  }
}

/**
 * POST /api/tags — Create a new hub tag
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, color } = body;

    if (!name) {
      return ApiErrors.badRequest('Tag name is required');
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `tag-${slug}`;
    const now = new Date().toISOString();

    // Check if a tag with this slug already exists (may have a different ID from connector sync)
    const [existing] = await db.select({ id: tags.id, name: tags.name, slug: tags.slug, type: tags.type, color: tags.color })
      .from(tags)
      .where(eq(tags.slug, slug))
      .limit(1);

    if (existing) {
      // Return the existing tag instead of creating a duplicate
      return NextResponse.json({ id: existing.id, name: existing.name, slug: existing.slug, type: existing.type, color: existing.color }, { status: 200 });
    }

    await db.insert(tags).values({
      id,
      name,
      slug,
      type: 'hub',
      source: null,
      color: color || '#6b7280',
      confirmed: true,
      createdAt: now,
    });

    return NextResponse.json({ id, name, slug, type: 'hub', color: color || '#6b7280' }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create tag', error);
  }
}

/**
 * PATCH /api/tags — Update a tag (color, name, confirm AI tag)
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id: tagId, name, color, confirmed } = body;

    if (!tagId) {
      return ApiErrors.badRequest('Tag id is required');
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      updates.name = name;
      updates.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    if (color !== undefined) updates.color = color;
    if (confirmed !== undefined) updates.confirmed = confirmed;

    await db.update(tags).set(updates).where(eq(tags.id, tagId));

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
    const tag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
    if (!tag.length) {
      return ApiErrors.notFound('Tag');
    }
    if (tag[0].type === 'source') {
      return ApiErrors.forbidden('Cannot delete source tags — they are managed by the connector');
    }

    await db.delete(taskTags).where(eq(taskTags.tagId, tagId));
    await db.delete(tags).where(eq(tags.id, tagId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete tag', error);
  }
}
