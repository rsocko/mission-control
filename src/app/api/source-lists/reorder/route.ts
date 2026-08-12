import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { sourceLists } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

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

    runTransaction((tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        tx.update(sourceLists)
          .set({ sortOrder: i })
          .where(eq(sourceLists.id, orderedIds[i]))
          .run();
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to reorder source lists', error);
  }
}
