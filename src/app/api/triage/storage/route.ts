import { NextResponse } from 'next/server';
import { getThumbnailCacheStats, removeOrphanedThumbnails } from '@/lib/triage/thumbnail-cache';
import { purgeDismissedItems } from '@/lib/triage/lifecycle';
import { cleanupTriageItemStorage } from '@/lib/triage/capture-image-lifecycle';
import logger from '@/lib/logger';
import { publishSemanticEntityDelete } from '@/lib/semantic-index/publication-service';
import { getTriagePersistenceRepositories } from '@/lib/triage/persistence';

/**
 * GET /api/triage/storage
 *
 * Returns storage statistics: thumbnail cache size, item counts by status,
 * and cache health info.
 */
export async function GET() {
  try {
    const maintenance = getTriagePersistenceRepositories().maintenance;
    const [statusCounts, sourceCounts, cachedCount, externalCount] = await Promise.all([
      maintenance.countByStatus(),
      maintenance.countBySource(),
      maintenance.countCachedThumbnails(),
      maintenance.countExternalThumbnails(),
    ]);

    // Filesystem cache stats
    const cacheStats = await getThumbnailCacheStats();

    return NextResponse.json({
      items: {
        byStatus: statusCounts,
        bySource: sourceCounts,
        withCachedThumbnail: cachedCount,
        withExternalThumbnail: externalCount,
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
        const validFilenames = new Set(
          await getTriagePersistenceRepositories().maintenance.listCachedThumbnailFilenames(),
        );

        const removed = await removeOrphanedThumbnails(validFilenames);
        return NextResponse.json({ action: 'cleanup_orphans', removed });
      }

      case 'clear_expired': {
        const cleared = await getTriagePersistenceRepositories()
          .maintenance
          .clearExternalThumbnails();
        return NextResponse.json({ action: 'clear_expired', cleared });
      }

      case 'delete_by_source': {
        // Delete items for a given source platform (for clean re-import)
        // By default only deletes pending + dismissed; pass includeActioned=true for all
        const source = body.source;
        if (!source || typeof source !== 'string') {
          return NextResponse.json({ error: 'source is required for delete_by_source' }, { status: 400 });
        }

        const includeActioned = body.includeActioned === true;
        const sourceItems = await getTriagePersistenceRepositories().maintenance.deleteBySource({
          source,
          includeActioned,
        });
        await Promise.all(sourceItems.map(
          (item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl),
        ));
        await Promise.all(sourceItems.map(
          (item) => publishSemanticEntityDelete('triage-item', item.id),
        ));
        return NextResponse.json({
          action: 'delete_by_source',
          source,
          deleted: sourceItems.length,
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
