import { NextResponse } from 'next/server';
import { withRuntimeOperation } from '@/lib/telemetry/operations';
import {
  ingestTriageImport,
  ingestTriageImports,
  type TriageImportInput,
  type TriageImportResult,
} from '@/lib/triage/capture';
import { isValidTriageSource } from '@/lib/triage/query';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { cacheThumbnail } from '@/lib/triage/thumbnail-cache';
import logger from '@/lib/logger';

/**
 * Bulk import endpoint used by the browser extension's platform content
 * scripts (Reddit / Instagram / Facebook saved-items import). Accepts a
 * batch of normalized items and ingests each one through the same
 * dedup/AI-scoring pipeline as the single-item importers.
 *
 * The extension is expected to call this repeatedly with small batches
 * (e.g. 25-50 items) as it paginates through a platform's saved list, so
 * a single request timing out doesn't lose an entire import run.
 */

const MAX_BATCH_SIZE = 100;

interface BulkImportItem {
  sourcePlatform?: string;
  sourceId?: string;
  sourceUrl?: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  capturedAt?: string;
  thumbnailUrl?: string;
  rawMetadata?: Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function importBulk(request: Request) {
  try {
    if (!hasValidTriageCaptureKey(request)) {
      return NextResponse.json({ error: 'Unauthorized bulk import request' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as { items?: BulkImportItem[]; refreshThumbnails?: boolean };
    const items = Array.isArray(body.items) ? body.items : [];
    const refreshThumbnails = body.refreshThumbnails === true;

    if (items.length === 0) {
      return NextResponse.json({ error: 'items array is required and must be non-empty' }, { status: 400 });
    }

    if (items.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Too many items in one batch — max ${MAX_BATCH_SIZE}, got ${items.length}` },
        { status: 400 },
      );
    }

    let imported = 0;
    let skipped = 0;
    let refreshed = 0;
    const errors: string[] = [];
    const validInputs: TriageImportInput[] = [];

    for (const raw of items) {
      if (!isNonEmptyString(raw.sourcePlatform) || !isValidTriageSource(raw.sourcePlatform) || raw.sourcePlatform === 'all') {
        skipped += 1;
        errors.push(`Invalid or unsupported sourcePlatform: ${String(raw.sourcePlatform)}`);
        continue;
      }
      if (!isNonEmptyString(raw.sourceId) || !isNonEmptyString(raw.sourceUrl)) {
        skipped += 1;
        errors.push('Skipped item missing sourceId or sourceUrl');
        continue;
      }

      const input: TriageImportInput = {
        sourcePlatform: raw.sourcePlatform,
        sourceId: raw.sourceId,
        sourceUrl: raw.sourceUrl,
        canonicalUrl: isNonEmptyString(raw.canonicalUrl) ? raw.canonicalUrl : undefined,
        title: isNonEmptyString(raw.title) ? raw.title : raw.sourceUrl,
        description: isNonEmptyString(raw.description) ? raw.description : undefined,
        capturedAt: isNonEmptyString(raw.capturedAt) ? raw.capturedAt : undefined,
        thumbnailUrl: isNonEmptyString(raw.thumbnailUrl) ? raw.thumbnailUrl : undefined,
        rawMetadata: raw.rawMetadata && typeof raw.rawMetadata === 'object' ? raw.rawMetadata : undefined,
      };

      // Cache thumbnail locally for platforms with expiring CDN URLs (Instagram, TikTok)
      if (input.thumbnailUrl && ['instagram', 'tiktok'].includes(input.sourcePlatform)) {
        const identifier = extractIdentifier(input.sourcePlatform, input.sourceUrl, input.sourceId);
        if (identifier) {
          const cachedUrl = await cacheThumbnail(input.thumbnailUrl, input.sourcePlatform, identifier);
          if (cachedUrl) {
            input.thumbnailUrl = cachedUrl;
          }
        }
      }

      validInputs.push(input);
    }

    const importResults: Array<TriageImportResult | null> = [];
    try {
      importResults.push(...await ingestTriageImports(validInputs));
    } catch (error) {
      logger.warn({ err: error }, 'Batched triage import failed; retrying items individually');
      for (const input of validInputs) {
        try {
          importResults.push(await ingestTriageImport(input));
        } catch (itemError) {
          skipped += 1;
          errors.push(itemError instanceof Error ? itemError.message : 'Unknown ingest error');
          importResults.push(null);
        }
      }
    }

    for (let index = 0; index < importResults.length; index += 1) {
      const result = importResults[index];
      const input = validInputs[index];
      if (!result) continue;
      if (result.status === 'imported') {
        imported += 1;
      } else if (refreshThumbnails && input.thumbnailUrl) {
        // Item exists but we have a fresh thumbnail — update it
        const existingItem = result.item;
        if (existingItem && input.thumbnailUrl !== existingItem.thumbnailUrl) {
          const { updateTriageItemThumbnail } = await import('@/lib/triage');
          await updateTriageItemThumbnail(existingItem.id, input.thumbnailUrl);
          refreshed += 1;
        } else {
          skipped += 1;
        }
      } else {
        skipped += 1;
      }
    }

    return NextResponse.json({ imported, skipped, refreshed, errors, total: items.length });
  } catch (error) {
    logger.error({ err: error }, 'Failed to bulk-import triage items');
    return NextResponse.json({ error: 'Failed to bulk-import triage items' }, { status: 500 });
  }
}

export function POST(request: Request) {
  return withRuntimeOperation({
    kind: 'import',
    name: 'triage-bulk',
    traceId: request.headers.get('x-trace-id') ?? undefined,
    routeFamily: '/api/triage/import/bulk',
  }, () => importBulk(request));
}

/**
 * Extract a short, stable identifier from a source URL for use as the thumbnail filename.
 */
function extractIdentifier(platform: string, sourceUrl: string, sourceId: string): string | null {
  if (platform === 'instagram') {
    const match = sourceUrl.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  if (platform === 'tiktok') {
    const match = sourceUrl.match(/\/video\/(\d+)/);
    if (match) return match[1];
  }
  // Fallback: use the portion after the last colon in sourceId
  const colonIdx = sourceId.lastIndexOf(':');
  return colonIdx >= 0 ? sourceId.slice(colonIdx + 1) : sourceId;
}