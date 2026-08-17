import { NextResponse } from 'next/server';
import db from '@/db';
import { triageItems } from '@/db/schema';
import { like } from 'drizzle-orm';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { getThumbnailCacheStats, removeOrphanedThumbnails } from '@/lib/triage/thumbnail-cache';
import { purgeDismissedItems } from '@/lib/triage/lifecycle';
import logger from '@/lib/logger';

/**
 * POST /api/triage/maintenance
 *
 * Runs scheduled maintenance tasks for the triage system.
 * Designed to be called by a cron job (e.g. daily or weekly).
 *
 * Tasks performed:
 * 1. Purge dismissed items older than retention period (default 90 days)
 * 2. Remove orphaned thumbnail files (cached files with no DB reference)
 * 3. Log health metrics
 *
 * Configuration via query params:
 *   retentionDays — override default 90 day retention (min 7)
 *   dryRun — if "true", report what would be done without doing it
 */
export async function POST(request: Request) {
  if (!hasValidTriageCaptureKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const retentionDays = Math.max(7, parseInt(searchParams.get('retentionDays') || '90', 10));
  const dryRun = searchParams.get('dryRun') === 'true';

  try {
    const results: Record<string, unknown> = { dryRun, retentionDays };

    // 1. Purge aged dismissed items
    if (!dryRun) {
      results.purgedDismissed = await purgeDismissedItems(retentionDays);
    } else {
      // Count what would be purged
      const { sql } = await import('drizzle-orm');
      const { eq, and } = await import('drizzle-orm');
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const [count] = await db.select({
        count: sql<number>`count(*)`,
      }).from(triageItems).where(
        and(
          eq(triageItems.status, 'dismissed'),
          sql`${triageItems.ingestedAt} < ${cutoff}`,
        ),
      );
      results.wouldPurge = count?.count ?? 0;
    }

    // 2. Remove orphaned thumbnails
    const rows = await db.select({
      thumbnailUrl: triageItems.thumbnailUrl,
    }).from(triageItems).where(like(triageItems.thumbnailUrl, '/api/assets/thumbnails/%'));

    const validFilenames = new Set<string>();
    for (const row of rows) {
      if (row.thumbnailUrl) {
        const filename = row.thumbnailUrl.split('/').pop();
        if (filename) validFilenames.add(filename);
      }
    }

    if (!dryRun) {
      results.orphanedFilesRemoved = await removeOrphanedThumbnails(validFilenames);
    } else {
      // Count orphans
      const stats = await getThumbnailCacheStats();
      results.orphanedFilesEstimate = Math.max(0, stats.fileCount - validFilenames.size);
    }

    // 3. Cache health stats
    const cacheStats = await getThumbnailCacheStats();
    results.cacheStats = {
      fileCount: cacheStats.fileCount,
      totalMB: Math.round(cacheStats.totalBytes / 1024 / 1024 * 100) / 100,
      referencedFiles: validFilenames.size,
    };

    logger.info(results, 'Triage maintenance completed');
    return NextResponse.json(results);
  } catch (error) {
    logger.error({ err: error }, 'Triage maintenance failed');
    return NextResponse.json({ error: 'Maintenance failed' }, { status: 500 });
  }
}
