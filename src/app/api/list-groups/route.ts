import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import db from '@/db';
import { listGroups, sourceLists, tasks } from '@/db/schema';
import { asc, sql, and, eq, isNull, notInArray } from 'drizzle-orm';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';
import { ApiErrors, apiError } from '@/lib/api-error';

export async function GET() {
  try {
    const [groups, lists, taskCounts] = await Promise.all([
      db.select().from(listGroups).orderBy(asc(listGroups.sortOrder), asc(listGroups.name)),
      db.select().from(sourceLists).orderBy(asc(sourceLists.name)),
      db
        .select({
          sourceListId: tasks.sourceListId,
          connectorInstanceId: tasks.connectorInstanceId,
          count: sql<number>`count(*)`.as('count'),
        })
        .from(tasks)
        .where(and(
          notInArray(tasks.status, ['done', 'cancelled']),
          isNull(tasks.parentId),
          eq(tasks.isChecklistItem, false),
        ))
        .groupBy(tasks.sourceListId, tasks.connectorInstanceId),
    ]);

    const countMap = new Map(
      taskCounts.map((row) => [`${row.connectorInstanceId}:${row.sourceListId}`, Number(row.count ?? 0)]),
    );

    const enrichedLists = lists.map((sourceList) => ({
      ...sourceList,
      name: resolveSourceListDisplayName(sourceList),
      taskCount: countMap.get(`${sourceList.connectorInstanceId}:${sourceList.sourceId}`) || 0,
    }));

    const groupsWithLists = groups.map((group) => ({
      ...group,
      sourceLists: enrichedLists
        .filter((sourceList) => sourceList.groupId === group.id)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
    }));

    return NextResponse.json({
      groups: groupsWithLists,
      ungroupedLists: enrichedLists.filter((sourceList) => !sourceList.groupId),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch list groups', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const icon = typeof body.icon === 'string' ? body.icon.trim() : '';
    const iconColor = typeof body.iconColor === 'string' ? body.iconColor.trim() : '';

    if (!name) {
      return ApiErrors.badRequest('Group name is required');
    }

    // Validate emoji safety — icon+name combined is what gets synced
    const displayName = icon ? `${icon}${name}` : name;
    const emojiWarning = validateNameForGraphApi(displayName);
    if (emojiWarning) {
      return apiError(emojiWarning, 'UNSAFE_EMOJI', 422);
    }

    const [maxSortOrder] = await db
      .select({ value: sql<number>`coalesce(max(${listGroups.sortOrder}), -1)` })
      .from(listGroups);

    const id = randomUUID();
    const createdAt = new Date().toISOString();

    await db.insert(listGroups).values({
      id,
      name,
      icon: icon || null,
      iconColor: iconColor || null,
      sortOrder: Number(maxSortOrder?.value ?? -1) + 1,
      createdAt,
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create list group', error);
  }
}
