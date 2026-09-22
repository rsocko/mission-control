import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { BugReportTagInput } from '@/db/persistence/operational-utility';
import logger from '@/lib/logger';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bug-Snap-Key',
};

function hasValidKey(request: Request): boolean {
  const expected = process.env.MC_BUG_SNAP_KEY || process.env.MC_TRIAGE_CAPTURE_KEY;
  if (!expected) return true;

  const keyHeader = request.headers.get('x-bug-snap-key');
  if (keyHeader && keyHeader === expected) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === expected;
  }

  return false;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  try {
    if (!hasValidKey(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    const body = await request.json();

    if (typeof body.title !== 'string' || !body.title.trim()) {
      return NextResponse.json(
        { error: 'title is required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const { operationalUtility } = await getWorkerPersistenceRepositories();
    if (!operationalUtility) {
      return NextResponse.json(
        { error: 'Operational utility persistence is not available in the selected backend' },
        { status: 503, headers: CORS_HEADERS },
      );
    }

    const now = new Date().toISOString();
    const taskId = randomUUID();
    const appName = typeof body.app === 'string' ? body.app : 'unknown';
    const severity = typeof body.severity === 'string' ? body.severity : 'low';

    // Build description with metadata
    const descParts: string[] = [];
    if (body.description) descParts.push(body.description);
    descParts.push(`\n---\n**Source app:** ${appName}`);
    descParts.push(`**Severity:** ${severity}`);
    if (body.url) descParts.push(`**URL/Route:** ${body.url}`);
    if (body.context) descParts.push(`**Context:** ${body.context}`);

    // The canonical #bug tag always applies; the app tag is added only when the
    // reporter identified itself.
    const reportTags: BugReportTagInput[] = [
      { slug: 'bug', name: 'bug', color: '#ef4444', newTagId: randomUUID() },
    ];
    if (appName !== 'unknown') {
      reportTags.push({
        slug: `app-${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: appName,
        color: '#6366f1',
        newTagId: randomUUID(),
      });
    }

    // Task and tag associations are created in one backend transaction, so a
    // partially tagged report is never observable.
    await operationalUtility.bugReports.create({
      task: {
        id: taskId,
        sourceId: `bug-snap-${taskId}`,
        connectorType: 'local',
        connectorInstanceId: 'bug-snap',
        title: `🐛 ${body.title.trim()}`,
        description: descParts.join('\n'),
        status: 'todo',
        priority: severity === 'critical' ? 'high' : severity === 'medium' ? 'medium' : 'none',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
        metadata: {
          bugSnap: true,
          app: appName,
          severity,
          url: body.url || null,
          reportedAt: now,
        },
      },
      tags: reportTags,
    });

    return NextResponse.json(
      { id: taskId, message: 'Bug reported successfully' },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to create bug report');
    return NextResponse.json(
      { error: 'Failed to create bug report' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
