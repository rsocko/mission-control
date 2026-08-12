/**
 * @deprecated Use /api/finance/notifications/[id]/dismiss instead.
 * Forwards to the new endpoint, remapping response for backward compat.
 */
import { NextResponse } from 'next/server';
import { PATCH as newPATCH } from '../../../../finance/notifications/[id]/dismiss/route';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const response = await newPATCH(request, context);
  const data = await response.json();
  return NextResponse.json({
    ...data,
    alertId: data.notificationId,
  });
}
