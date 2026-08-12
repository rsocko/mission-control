import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs, sourceLists } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/connectors/github-repos
 *
 * Returns all GitHub repos available from connected github-issues connectors.
 * Used by the intake wizard to populate the target repo dropdown.
 */
export async function GET() {
  try {
    // Fetch enabled, non-deleted github-issues connectors
    const configs = await db
      .select({
        id: connectorConfigs.id,
        name: connectorConfigs.name,
        settings: connectorConfigs.settings,
      })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.type, 'github-issues'),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      );

    // Also fetch source lists (repos) for these connectors
    const connectorIds = configs.map(c => c.id);
    const lists = connectorIds.length > 0
      ? await db
          .select({
            connectorInstanceId: sourceLists.connectorInstanceId,
            sourceId: sourceLists.sourceId,
            name: sourceLists.name,
          })
          .from(sourceLists)
          .where(eq(sourceLists.type, 'repo'))
      : [];

    // Build a flat list of repos with their connector info
    const repos: Array<{
      connectorId: string;
      connectorName: string;
      repo: string;        // owner/repo
      displayName: string;  // source list name or repo slug
    }> = [];

    for (const config of configs) {
      // Repos configured in settings
      const settings = (config.settings ?? {}) as { repos?: string[] };
      const configuredRepos = settings.repos ?? [];

      // Repos discovered as source lists
      const connectorLists = lists.filter(l => l.connectorInstanceId === config.id);

      // Merge: use source lists if available, fall back to settings.repos
      const repoSet = new Set<string>();

      for (const sl of connectorLists) {
        if (!repoSet.has(sl.sourceId)) {
          repoSet.add(sl.sourceId);
          repos.push({
            connectorId: config.id,
            connectorName: config.name,
            repo: sl.sourceId,
            displayName: sl.name,
          });
        }
      }

      for (const repo of configuredRepos) {
        if (!repoSet.has(repo)) {
          repoSet.add(repo);
          repos.push({
            connectorId: config.id,
            connectorName: config.name,
            repo,
            displayName: repo.split('/').pop() ?? repo,
          });
        }
      }
    }

    return NextResponse.json({ repos });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch GitHub repos', error);
  }
}
