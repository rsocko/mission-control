import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const { id } = await params;

    const dismissedAt = new Date().toISOString();

    await db
      .update(notifications)
      .set({
        state: 'dismissed',
        readState: 'read',
        disposition: 'dismissed',
        readAt: dismissedAt,
        dismissedAt,
      })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.category, 'finance'),
        )
      );

    return NextResponse.json({
      success: true,
      notificationId: id,
      dismissedAt,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to dismiss notification', error);
  }
}
