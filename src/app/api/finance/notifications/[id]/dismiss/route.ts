import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

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

    await (
      await getWorkerPersistenceRepositories()
    ).finance.web.dismissNotification(id, dismissedAt);

    return NextResponse.json({
      success: true,
      notificationId: id,
      dismissedAt,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to dismiss notification', error);
  }
}
