import { NextResponse } from 'next/server';
import db from '@/db';
import { triageItems } from '@/db/schema';
import { eq, sql, and, like, inArray } from 'drizzle-orm';
import { getThumbnailCacheStats, removeOrphanedThumbnails } from '@/lib/triage/thumbnail-cache';
import { purgeDismissedItems } from '@/lib/triage/lifecycle';
import { cleanupTriageItemStorage } from '@/lib/triage/capture-image-lifecycle';
import logger from '@/lib/logger';

/**
 * GET /api/triage/storage
 *
 * Returns storage statistics: thumbnail cache size, item counts by status,
 * and cache health info.
 */
export async function GET() {
  try {
    // Item counts by status
    const statusCounts = await db.select({
      status: triageItems.status,
      count: sql<number>`count(*)`,
    }).from(triageItems).groupBy(triageItems.status);

    // Count items with cached thumbnails
    const [cachedCount] = await db.select({
      count: sql<number>`count(*)`,
    }).from(triageItems).where(like(triageItems.thumbnailUrl, '/api/assets/thumbnails/%'));

    // Count items with expired/external thumbnail URLs
    const [externalCount] = await db.select({
      count: sql<number>`count(*)`,
    }).from(triageItems).where(
      and(
        sql`${triageItems.thumbnailUrl} IS NOT NULL`,
        sql`${triageItems.thumbnailUrl} NOT LIKE '/api/assets/thumbnails/%'`,
        sql`${triageItems.thumbnailUrl} NOT LIKE '/api/triage/capture/image/%'`,
      ),
    );

    // Per-source platform counts
    const sourceCounts = await db.select({
      sourcePlatform: triageItems.sourcePlatform,
      count: sql<number>`count(*)`,
    }).from(triageItems).groupBy(triageItems.sourcePlatform);

    // Filesystem cache stats
    const cacheStats = await getThumbnailCacheStats();

    return NextResponse.json({
      items: {
        byStatus: Object.fromEntries(statusCounts.map((r) => [r.status, r.count])),
        bySource: Object.fromEntries(sourceCounts.map((r) => [r.sourcePlatform, r.count])),
        withCachedThumbnail: cachedCount?.count ?? 0,
        withExternalThumbnail: externalCount?.count ?? 0,
      },
      cache: {
        fileCount: cacheStats.fileCount,
        totalBytes: cacheStats.totalBytes,
        totalMB: Math.round(cacheStats.totalBytes / 1024 / 1024 * 100) / 100,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get storage stats');
    return NextResponse.json({ error: 'Failed to get storage stats' }, { status: 500 });
  }
}

/**
 * POST /api/triage/storage
 *
 * Storage maintenance actions:
 *   action=purge_dismissed — purge dismissed items older than retentionDays (default 90)
 *   action=cleanup_orphans — remove thumbnail files with no matching DB row
 *   action=clear_expired — null out external thumbnailUrls that aren't cached (so UI uses embed fallback)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      retentionDays?: number;
      source?: string;
      includeActioned?: boolean;
    };

    switch (body.action) {
      case 'purge_dismissed': {
        const days = body.retentionDays ?? 90;
        const purged = await purgeDismissedItems(days);
        return NextResponse.json({ action: 'purge_dismissed', purged, retentionDays: days });
      }

      case 'cleanup_orphans': {
        // Get all valid cached thumbnail filenames from the DB
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

        const removed = await removeOrphanedThumbnails(validFilenames);
        return NextResponse.json({ action: 'cleanup_orphans', removed });
      }

      case 'clear_expired': {
        // Clear external (non-cached) thumbnailUrls so the UI falls back to embed
        const result = await db.update(triageItems).set({ thumbnailUrl: null }).where(
          and(
            sql`${triageItems.thumbnailUrl} IS NOT NULL`,
            sql`${triageItems.thumbnailUrl} NOT LIKE '/api/assets/thumbnails/%'`,
            sql`${triageItems.thumbnailUrl} NOT LIKE '/api/triage/capture/image/%'`,
          ),
        );
        return NextResponse.json({ action: 'clear_expired', cleared: result.changes });
      }

      case 'delete_by_source': {
        // Delete items for a given source platform (for clean re-import)
        // By default only deletes pending + dismissed; pass includeActioned=true for all
        const source = body.source;
        if (!source || typeof source !== 'string') {
          return NextResponse.json({ error: 'source is required for delete_by_source' }, { status: 400 });
        }

        const includeActioned = body.includeActioned === true;
        const statusFilter = includeActioned
          ? eq(triageItems.sourcePlatform, source)
          : and(
              eq(triageItems.sourcePlatform, source),
              inArray(triageItems.status, ['pending', 'dismissed']),
            );

        // Remove cached thumbnails for these items
        const sourceItems = await db.select({
          id: triageItems.id,
          thumbnailUrl: triageItems.thumbnailUrl,
          sourceUrl: triageItems.sourceUrl,
        }).from(triageItems).where(statusFilter);

        const result = await db.delete(triageItems).where(statusFilter);
        await Promise.all(sourceItems.map(
          (item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl),
        ));
        return NextResponse.json({
          action: 'delete_by_source',
          source,
          deleted: result.changes,
          includeActioned,
          preserved: includeActioned ? 0 : undefined,
        });
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: purge_dismissed, cleanup_orphans, clear_expired, delete_by_source' },
          { status: 400 },
        );
    }
  } catch (error) {
    logger.error({ err: error }, 'Storage action failed');
    return NextResponse.json({ error: 'Storage action failed' }, { status: 500 });
  }
}
