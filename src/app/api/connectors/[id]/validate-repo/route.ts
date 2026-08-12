import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * POST /api/connectors/[id]/validate-repo
 * Validates that a GitHub repo exists using the connector's stored token.
 * Keeps the PAT server-side — never sends it to the browser.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json() as { repo: string };
  const repo = body.repo?.trim();

  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json({ valid: false, error: 'Invalid format. Use owner/repo.' }, { status: 400 });
  }

  try {
    const [connector] = await db
      .select({ credentials: connectorConfigs.credentials, type: connectorConfigs.type })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id))
      .limit(1);

    if (!connector) {
      return NextResponse.json({ valid: false, error: 'Connector not found' }, { status: 404 });
    }

    if (connector.type !== 'github-issues') {
      return NextResponse.json({ valid: false, error: 'Not a GitHub connector' }, { status: 400 });
    }

    const creds = (typeof connector.credentials === 'string'
      ? JSON.parse(connector.credentials)
      : connector.credentials) as Record<string, string>;
    const token = creds?.token || creds?.pat;

    if (!token) {
      return NextResponse.json({ valid: false, error: 'No GitHub token configured' }, { status: 400 });
    }

    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (res.status === 404) {
      return NextResponse.json({ valid: false, error: 'Repository not found or no access' });
    }

    if (!res.ok) {
      return NextResponse.json({ valid: false, error: `GitHub returned ${res.status}` });
    }

    const repoData = await res.json();
    return NextResponse.json({
      valid: true,
      fullName: repoData.full_name,
      openIssues: repoData.open_issues_count,
    });
  } catch (error) {
    return NextResponse.json(
      { valid: false, error: 'Failed to validate repository' },
      { status: 500 }
    );
  }
}
