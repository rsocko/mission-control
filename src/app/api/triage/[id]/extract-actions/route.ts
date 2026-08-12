import { NextResponse } from 'next/server';
import { getTriageItemById } from '@/lib/triage';
import { extractMultipleActions } from '@/lib/triage/actions/multi-action-extract';
import logger from '@/lib/logger';

/**
 * POST /api/triage/[id]/extract-actions
 *
 * Uses AI to detect multiple actionable items in a triage item's content.
 * Returns the extracted actions so the UI can offer to create multiple tasks.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const item = await getTriageItemById(id);

    if (!item) {
      return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
    }

    const result = await extractMultipleActions(item);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to extract actions';
    logger.error({ err: error }, 'Failed to extract multi-actions from triage item');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
