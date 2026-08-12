import { NextResponse } from 'next/server';
import { and, asc, eq, isNull } from 'drizzle-orm';
import db from '@/db';
import { connectorConfigs, hubProjects, sourceLists, tags } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';

export async function GET() {
  try {
    const [projects, tagRows, sourceRows] = await Promise.all([
      db.select({
        id: hubProjects.id,
        name: hubProjects.name,
        description: hubProjects.description,
        color: hubProjects.color,
      })
        .from(hubProjects)
        .where(eq(hubProjects.hidden, false))
        .orderBy(asc(hubProjects.name)),
      db.select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
        .from(tags)
        .where(and(eq(tags.confirmed, true), isNull(tags.unifiedInto)))
        .orderBy(asc(tags.name)),
      db.select({
        connectorInstanceId: sourceLists.connectorInstanceId,
        sourceId: sourceLists.sourceId,
        name: sourceLists.name,
        userDisplayName: sourceLists.userDisplayName,
        connectorName: connectorConfigs.name,
        color: sourceLists.iconColor,
      })
        .from(sourceLists)
        .innerJoin(connectorConfigs, eq(sourceLists.connectorInstanceId, connectorConfigs.id))
        .where(and(
          eq(sourceLists.hidden, false),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ))
        .orderBy(asc(connectorConfigs.name), asc(sourceLists.name)),
    ]);

    return NextResponse.json({
      projects,
      tags: tagRows,
      sources: sourceRows.map((source) => ({
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
