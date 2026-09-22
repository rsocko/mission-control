import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

/**
 * Bulk-update source list sortOrder values within a group.
 * Body: { orderedIds: string[] }
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const orderedIds: string[] = body.orderedIds;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
    }

    await (await getConnectorManagementPersistence()).reorderSourceLists(orderedIds);

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to reorder source lists', error);
  }
}
