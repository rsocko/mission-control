import { NextResponse } from 'next/server';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { ApiErrors } from '@/lib/api-error';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const snapshot = await (
      await getConnectorManagementPersistence()
    ).getConnectorListSnapshot(id);
    const { connector } = snapshot;

    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    const countMap = new Map(
      snapshot.openTaskCounts.map((count) => [count.sourceListId, count.count]),
    );

    const listsWithCounts = snapshot.sourceLists
      .filter(sl => isSourceListSelected(connector, sl))
      .map(sl => ({
        ...sl,
        name: resolveSourceListDisplayName(sl),
        taskCount: countMap.get(sl.sourceId) || 0,
        selectedForSync: true,
      }));

    const selectedGroupIds = new Set(
      listsWithCounts
        .map((sourceList) => sourceList.groupId)
        .filter((groupId): groupId is string => Boolean(groupId)),
    );
    const groups = snapshot.groups.filter((group) => selectedGroupIds.has(group.id));

    return NextResponse.json({ sourceLists: listsWithCounts, groups });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch connector source lists', error);
  }
}
