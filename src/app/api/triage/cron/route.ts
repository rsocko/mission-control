import { NextResponse } from 'next/server';
import { runAllDueSyncs, getHealthStatus, getSyncLockStatus } from '@/lib/triage/auto-sync-agent';
import logger from '@/lib/logger';

/**
 * GET /api/triage/cron
 *
 * Designed to be called by an external scheduler (cron job, n8n, Vercel cron, etc.).
 * Runs all due source syncs and returns aggregate results.
 *
 * Optionally include ?digest=daily or ?digest=weekly to trigger digest generation.
 *
 * Security: Check for MC_TRIAGE_AUTO_SYNC_ENABLED env var.
 */
export async function GET(request: Request) {
  // Guard: must be enabled
  const enabled = process.env.MC_TRIAGE_AUTO_SYNC_ENABLED;
  if (enabled !== 'true' && enabled !== '1') {
    return NextResponse.json(
      { error: 'Auto-sync is disabled. Set MC_TRIAGE_AUTO_SYNC_ENABLED=true to enable.' },
      { status: 403 },
    );
  }

  // Check if already running
  if (getSyncLockStatus()) {
    return NextResponse.json(
      { message: 'Sync already in progress', locked: true },
      { status: 409 },
    );
  }

  try {
    const result = await runAllDueSyncs();

    // Optionally trigger digest
    const url = new URL(request.url);
    const digestParam = url.searchParams.get('digest');
    let digest = null;

    if (digestParam === 'daily' || digestParam === 'weekly') {
      const { generateTriageDigest } = await import('@/lib/triage/digest');
      digest = await generateTriageDigest(digestParam);
    }

    const health = getHealthStatus();

    logger.info(
      {
        totalImported: result.totalImported,
        totalErrors: result.totalErrors,
        durationMs: result.totalDurationMs,
      },
      'Cron sync completed',
    );

    return NextResponse.json({
      sync: result,
      health,
      digest,
    });
  } catch (error) {
    logger.error({ err: error }, 'Cron sync endpoint failed');
    return NextResponse.json({ error: 'Cron sync failed' }, { status: 500 });
  }
}
