import { NextResponse } from 'next/server';
import { z } from 'zod';
import { FinanceManagerConnector } from '@/lib/connectors/monarch-money';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { MonarchBridgeError } from '@/lib/connectors/monarch-money/client';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import db from '@/db';
import { financeTransactions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';

const requestSchema = z.object({
  categoryId: z.string().trim().min(1).max(200),
  connectorId: z.string().trim().min(1).max(200).optional(),
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const { id } = await params;
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'A valid categoryId is required' }, { status: 400 });
    }
    const { categoryId, connectorId } = parsed.data;
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() || undefined;

    if (isDemoMode()) {
      const result = await db.update(financeTransactions).set({
        confirmedCategory: categoryId,
        triageStatus: 'confirmed',
      }).where(and(
        eq(financeTransactions.id, id),
        eq(financeTransactions.connectorInstanceId, config.id),
        eq(financeTransactions.lifecycleStatus, 'active'),
      ));
      if (result.changes === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
      return NextResponse.json({ status: 'updated', transactionId: id, categoryId });
    }

    const connector = new FinanceManagerConnector();
    await connector.initialize(config);
    const result = await connector.updateCategory(
      id,
      categoryId,
      idempotencyKey,
      request.signal,
    );
    return NextResponse.json({
      ...result,
      transactionId: id,
      categoryId,
    });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MonarchBridgeError) {
      const status = error.status && error.status >= 400 && error.status < 500
        ? error.status
        : error.code === 'upstream_timeout'
          ? 504
          : 502;
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status });
    }
    return ApiErrors.internal('Failed to update category', error);
  }
}
