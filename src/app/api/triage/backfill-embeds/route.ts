import { NextResponse } from 'next/server';
import { resolveAndStoreEmbed } from '@/lib/triage/capture';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { DomainRateLimiter } from '@/lib/triage/domain-rate-limiter';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getTriagePersistenceRepositories } from '@/lib/triage/persistence';

const rateLimiter = new DomainRateLimiter();
let backfillActive = false;

/**
 * POST /api/triage/backfill-embeds
 *
 * Backfill embed metadata for existing triage items that don't have it.
 * Processes items sequentially under the per-domain rate limiter.
 *
 * Query params:
 *   limit — max items to process (default 50, max 200)
 *   dryRun — if "true", just return items that would be processed
 *   force — if "true", re-resolve even items that already have embed data
 *   source — filter to a specific source platform (e.g. "instagram", "github")
 *   cursor — resume after the last returned item ID
 */
export async function POST(request: Request) {
  if (!hasValidTriageCaptureKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit') || '50';
  const limitParam = Number(rawLimit);
  if (!Number.isInteger(limitParam) || limitParam < 1) {
    return ApiErrors.validation('limit must be a positive integer');
  }
  const limit = Math.min(Math.max(1, limitParam), 200);
  const dryRun = searchParams.get('dryRun') === 'true';
  const force = searchParams.get('force') === 'true';
  const sourceFilter = searchParams.get('source') || null;
  const cursor = searchParams.get('cursor') || null;
  if (sourceFilter && Array.from(sourceFilter).length > 128) {
    return ApiErrors.validation('source cannot exceed 128 characters');
  }
  if (cursor && Array.from(cursor).length > 128) {
    return ApiErrors.validation('cursor cannot exceed 128 characters');
  }

  if (!dryRun && backfillActive) {
    return ApiErrors.conflict('An embed backfill is already running');
  }
  if (!dryRun) backfillActive = true;

  try {
    const {
      items: selectedItems,
      nextCursor,
    } = await getTriagePersistenceRepositories().items.listEmbedBackfillCandidates({
      limit,
      force,
      ...(sourceFilter ? { source: sourceFilter } : {}),
      ...(cursor ? { cursor } : {}),
    });

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        scanned: selectedItems.length,
        selected: selectedItems.length,
        resolved: 0,
        failed: 0,
        skipped: 0,
        nextCursor,
        items: selectedItems.map((item) => ({
          id: item.id,
          url: item.canonicalUrl || item.sourceUrl,
        })),
      });
    }

    const results = {
      scanned: selectedItems.length,
      selected: selectedItems.length,
      resolved: 0,
      failed: 0,
      skipped: 0,
      nextCursor,
      errors: [] as string[],
    };

    for (const item of selectedItems) {
      const url = item.canonicalUrl || item.sourceUrl;
      try {
        const hostname = new URL(url).hostname;
        await rateLimiter.waitForSlot(hostname);
        const embed = await resolveAndStoreEmbed(item.id, url, { fillOnly: !force });
        if (embed) {
          results.resolved++;
        } else {
          results.failed++;
          results.errors.push(`${item.id}: no embed data resolved`);
        }
      } catch (err) {
        results.failed++;
        results.errors.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    logger.error({ err: error }, 'Backfill embeds failed');
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  } finally {
    if (!dryRun) backfillActive = false;
  }
}
