import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

export async function GET() {
  try {
    const {
      projects,
      tags,
      sources,
    } = await (await getTaskCorePersistence()).priorityEntities.listPriorityEntityOptions();

    return NextResponse.json({
      projects,
      tags: tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
      })),
      sources: sources.map((source) => ({
        id: `${source.connectorInstanceId}:${source.sourceId}`,
        name: resolveSourceListDisplayName(source),
        label: `${resolveSourceListDisplayName(source)} — ${source.connectorName}`,
        description: source.connectorName,
        color: source.color,
      })),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch priority entity options', error);
  }
}
