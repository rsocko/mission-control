import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs, sourceLists, tasks, listGroups } from '@/db/schema';
import { asc, eq, and, sql, ne } from 'drizzle-orm';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { ApiErrors } from '@/lib/api-error';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [connector] = await db.select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id))
      .limit(1);

    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    const lists = await db.select()
      .from(sourceLists)
      .where(eq(sourceLists.connectorInstanceId, id))
      .orderBy(asc(sourceLists.sortOrder), asc(sourceLists.name));

    // Compute actual task counts from the tasks table (open tasks only, exclude checklist items)
    const taskCounts = await db
      .select({
        sourceListId: tasks.sourceListId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(tasks)
      .where(and(eq(tasks.connectorInstanceId, id), ne(tasks.status, 'done'), eq(tasks.isChecklistItem, false)))
      .groupBy(tasks.sourceListId);

    const countMap = new Map(taskCounts.map(tc => [tc.sourceListId, tc.count]));

    const listsWithCounts = lists.map(sl => ({
      ...sl,
      name: resolveSourceListDisplayName(sl),
      taskCount: countMap.get(sl.sourceId) || 0,
    }));

    // Fetch list groups referenced by these lists
    const groupIds = [...new Set(lists.map(l => l.groupId).filter(Boolean))] as string[];
    let groups: { id: string; name: string; sortOrder: number }[] = [];
    if (groupIds.length > 0) {
      groups = await db.select({
        id: listGroups.id,
        name: listGroups.name,
        sortOrder: listGroups.sortOrder,
      })
        .from(listGroups)
        .where(sql`${listGroups.id} IN (${sql.join(groupIds.map(gid => sql`${gid}`), sql`, `)})`)
        .orderBy(asc(listGroups.sortOrder));
    }

    return NextResponse.json({ sourceLists: listsWithCounts, groups });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch connector source lists', error);
  }
}
