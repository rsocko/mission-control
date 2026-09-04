import { NextResponse } from 'next/server';
import { createGitHubClient } from '@/lib/connectors/github-issues/github-client';
import { scanForNonCanonicalLabels } from '@/lib/connectors/github-issues/label-handler';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

/**
 * GET /api/connectors/[id]/label-scan
 * Scans a GitHub connector's repos for non-canonical priority and effort labels.
 * Returns a list of labels that should be normalized, with issue counts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const connector = await (
      await getConnectorManagementPersistence()
    ).getConnector(id);

    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    if (connector.type !== 'github-issues') {
      return NextResponse.json({ error: 'Label scan only applies to GitHub connectors' }, { status: 400 });
    }

    const creds = (typeof connector.credentials === 'string'
      ? JSON.parse(connector.credentials)
      : connector.credentials) as Record<string, string>;
    const settings = (typeof connector.settings === 'string'
      ? JSON.parse(connector.settings)
      : connector.settings) as Record<string, unknown>;

    const client = createGitHubClient(creds.token);
    const repos = (settings.repos as string[]) || [];

    const allNormalizations = [];
    for (const repo of repos) {
      const [owner, name] = repo.split('/');
      if (!owner || !name) continue;

      const normalizations = await scanForNonCanonicalLabels(client, owner, name);
      allNormalizations.push(
        ...normalizations.map(n => ({ ...n, repo })),
      );
    }

    const totalIssuesAffected = allNormalizations.reduce((sum, n) => sum + n.issueCount, 0);
    // Each issue needs ~2 API calls (add label + remove label), plus pagination + label creation
    const estimatedApiCalls = totalIssuesAffected * 2 + allNormalizations.length * 2;

    return NextResponse.json({
      normalizations: allNormalizations,
      reposScanned: repos.length,
      totalLabelsToNormalize: allNormalizations.length,
      totalIssuesAffected,
      estimatedApiCalls,
      rateLimitWarning: estimatedApiCalls > 500
        ? `This will make ~${estimatedApiCalls} GitHub API calls. Large normalizations may take a while and consume rate limit.`
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
