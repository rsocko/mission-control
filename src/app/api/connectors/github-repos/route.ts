import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

/**
 * GET /api/connectors/github-repos
 *
 * Returns all GitHub repos available from connected github-issues connectors.
 * Used by the intake wizard to populate the target repo dropdown.
 */
export async function GET() {
  try {
    const { connectors: configs, sourceLists: lists } = await (
      await getConnectorManagementPersistence()
    ).getGitHubRepositorySnapshot();

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
