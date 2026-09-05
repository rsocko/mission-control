import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { reorderListGroups } from '@/lib/list-groups/service';

/**
 * Bulk-update group sortOrder values.
 * Body: { orderedIds: string[] }
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const orderedIds: string[] = body.orderedIds;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
    }

    await reorderListGroups(orderedIds);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to reorder groups', error);
  }
}
