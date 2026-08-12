import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import db from '@/db';
import { tasks, tags, taskTags } from '@/db/schema';
import { eq } from 'drizzle-orm';
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

    // Create the task (using 'local' connector for MC-native tasks)
    await db.insert(tasks).values({
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
      metadata: JSON.stringify({
        bugSnap: true,
        app: appName,
        severity,
        url: body.url || null,
        reportedAt: now,
      }),
    });

    // Ensure #bug tag exists and associate it
    const bugTagSlug = 'bug';
    const existingTag = await db.select().from(tags).where(eq(tags.slug, bugTagSlug)).limit(1);
    let tagId: string;

    if (existingTag.length > 0) {
      tagId = existingTag[0].id;
    } else {
      tagId = randomUUID();
      await db.insert(tags).values({
        id: tagId,
        name: 'bug',
        slug: bugTagSlug,
        type: 'hub',
        color: '#ef4444',
        confirmed: true,
        createdAt: now,
      });
    }

    await db.insert(taskTags).values({ taskId, tagId });

    // Also tag with app name if provided
    if (appName !== 'unknown') {
      const appTagSlug = `app-${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const existingAppTag = await db.select().from(tags).where(eq(tags.slug, appTagSlug)).limit(1);
      let appTagId: string;

      if (existingAppTag.length > 0) {
        appTagId = existingAppTag[0].id;
      } else {
        appTagId = randomUUID();
        await db.insert(tags).values({
          id: appTagId,
          name: appName,
          slug: appTagSlug,
          type: 'hub',
          color: '#6366f1',
          confirmed: true,
          createdAt: now,
        });
      }

      await db.insert(taskTags).values({ taskId, tagId: appTagId });
    }

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
