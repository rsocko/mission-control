import { NextResponse } from 'next/server';
import { triageSyncScheduler } from '@/lib/triage/scheduler';
import type { TriageAutoSyncConfig, TriageSourceId } from '@/lib/triage/scheduler';
import logger from '@/lib/logger';

/**
 * GET /api/triage/auto-sync — Returns current auto-sync configuration and job status.
 */
export async function GET() {
  try {
    const config = await triageSyncScheduler.getConfig();
    const status = triageSyncScheduler.getStatus();
    return NextResponse.json({ config, status });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get triage auto-sync config');
    return NextResponse.json({ error: 'Failed to get auto-sync config' }, { status: 500 });
  }
}

/**
 * PUT /api/triage/auto-sync — Update auto-sync configuration.
 *
 * Body: { sources: { "github-stars": { enabled: true, intervalMinutes: 30 } } }
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Partial<TriageAutoSyncConfig>;

    // Validate interval values
    if (body.sources) {
      for (const [sourceId, cfg] of Object.entries(body.sources)) {
        if (!['github-stars', 'reddit-saved', 'youtube', 'document-intelligence'].includes(sourceId)) {
          return NextResponse.json(
            { error: `Unknown source: ${sourceId}` },
            { status: 400 },
          );
        }
        if (cfg.intervalMinutes !== undefined) {
          if (typeof cfg.intervalMinutes !== 'number' || cfg.intervalMinutes < 5 || cfg.intervalMinutes > 1440) {
            return NextResponse.json(
              { error: `intervalMinutes must be between 5 and 1440 (24h)` },
              { status: 400 },
            );
          }
        }
      }
    }

    const updated = await triageSyncScheduler.updateConfig(body);
    const status = triageSyncScheduler.getStatus();

    return NextResponse.json({ config: updated, status });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update triage auto-sync config');
    return NextResponse.json({ error: 'Failed to update auto-sync config' }, { status: 500 });
  }
}

/**
 * POST /api/triage/auto-sync — Trigger an immediate import for a source.
 *
 * Body: { sourceId: "github-stars" }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { sourceId?: string };
    const sourceId = body.sourceId as TriageSourceId;

    if (!sourceId || !['github-stars', 'reddit-saved', 'youtube', 'document-intelligence'].includes(sourceId)) {
      return NextResponse.json(
        { error: 'sourceId must be "github-stars", "reddit-saved", "youtube", or "document-intelligence"' },
        { status: 400 },
      );
    }

    // Run async — don't block the response
    triageSyncScheduler.runImport(sourceId).catch((err) => {
      logger.error({ err, sourceId }, 'Manual triage import failed');
    });

    return NextResponse.json({ message: `Import started for ${sourceId}` });
  } catch (error) {
    logger.error({ err: error }, 'Failed to trigger triage import');
    return NextResponse.json({ error: 'Failed to trigger import' }, { status: 500 });
  }
}
