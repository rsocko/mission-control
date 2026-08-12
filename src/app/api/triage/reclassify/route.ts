import { NextResponse } from 'next/server';
import {
  reclassifyTriageItem,
  reclassifyTriageItems,
  setTriageItemContentType,
  setTriageItemsContentType,
} from '@/lib/triage';
import logger from '@/lib/logger';

/**
 * POST /api/triage/reclassify
 *
 * Actions:
 *   - { action: "auto", id: string }              → Re-detect content type for a single item
 *   - { action: "auto", ids: string[] }           → Re-detect content type for multiple items
 *   - { action: "auto" }                          → Re-detect content type for ALL items (backfill)
 *   - { action: "set_type", id: string, contentType: string }    → Manual override single item
 *   - { action: "set_type", ids: string[], contentType: string } → Manual override multiple items
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'auto') {
      // Single item reclassify
      if (typeof body.id === 'string') {
        const result = await reclassifyTriageItem(body.id);
        if (!result) {
          return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
        }
        return NextResponse.json({
          item: result.item,
          changed: result.changed,
          message: result.changed
            ? `Reclassified to "${result.item.contentType}"`
            : 'Content type unchanged',
        });
      }

      // Bulk or full reclassify
      const ids = Array.isArray(body.ids) ? body.ids : undefined;
      const result = await reclassifyTriageItems(ids);
      return NextResponse.json({
        total: result.total,
        changed: result.changed,
        results: result.results,
        message: `Reclassified ${result.changed} of ${result.total} items`,
      });
    }

    if (action === 'set_type') {
      const { contentType } = body;
      if (typeof contentType !== 'string' || !contentType) {
        return NextResponse.json({ error: 'Missing "contentType" field' }, { status: 400 });
      }

      // Single item manual override
      if (typeof body.id === 'string') {
        const item = await setTriageItemContentType(body.id, contentType);
        if (!item) {
          return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
        }
        return NextResponse.json({ item, message: `Content type set to "${contentType}"` });
      }

      // Bulk manual override
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const count = await setTriageItemsContentType(body.ids, contentType);
        return NextResponse.json({
          updated: count,
          message: `Set content type to "${contentType}" for ${count} items`,
        });
      }

      return NextResponse.json({ error: 'Missing "id" or "ids" field' }, { status: 400 });
    }

    return NextResponse.json({ error: 'Invalid action. Use "auto" or "set_type".' }, { status: 400 });
  } catch (error) {
    logger.error({ err: error }, 'Reclassify endpoint failed');
    return NextResponse.json({ error: 'Failed to reclassify' }, { status: 500 });
  }
}
