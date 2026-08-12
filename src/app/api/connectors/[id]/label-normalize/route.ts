import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createGitHubClient } from '@/lib/connectors/github-issues/github-client';
import { normalizeLabels } from '@/lib/connectors/github-issues/label-handler';
import type { LabelNormalization } from '@/lib/connectors/github-issues/label-handler';

/**
 * POST /api/connectors/[id]/label-normalize
 * Normalizes non-canonical priority and effort labels on a GitHub connector's repos.
 * Expects body: { normalizations: Array<LabelNormalization & { repo: string }> }
 * 
 * This performs the actual rename: for each normalization, re-labels all issues
 * from the old label to the canonical one, then deletes the old label.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json() as {
      normalizations: Array<LabelNormalization & { repo: string }>;
    };

    if (!body.normalizations || !Array.isArray(body.normalizations) || body.normalizations.length === 0) {
      return NextResponse.json({ error: 'No normalizations provided' }, { status: 400 });
    }

    const [connector] = await db
      .select({
        type: connectorConfigs.type,
        credentials: connectorConfigs.credentials,
      })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id))
      .limit(1);

    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    if (connector.type !== 'github-issues') {
      return NextResponse.json({ error: 'Label normalization only applies to GitHub connectors' }, { status: 400 });
    }

    const creds = (typeof connector.credentials === 'string'
      ? JSON.parse(connector.credentials)
      : connector.credentials) as Record<string, string>;

    const client = createGitHubClient(creds.token);

    // Group normalizations by repo
    const byRepo = new Map<string, LabelNormalization[]>();
    for (const norm of body.normalizations) {
      const existing = byRepo.get(norm.repo) || [];
      existing.push(norm);
      byRepo.set(norm.repo, existing);
    }

    let totalSucceeded = 0;
    let totalFailed = 0;
    const allErrors: string[] = [];

    for (const [repo, norms] of byRepo) {
      const [owner, name] = repo.split('/');
      if (!owner || !name) continue;

      const result = await normalizeLabels(client, owner, name, norms);
      totalSucceeded += result.succeeded;
      totalFailed += result.failed;
      allErrors.push(...result.errors);
    }

    return NextResponse.json({
      succeeded: totalSucceeded,
      failed: totalFailed,
      errors: allErrors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
