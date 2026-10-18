import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  actOnAttributionException,
  FinanceAttributionMutationError,
  resolveAttributionExceptionTransactionId,
} from '@/lib/connectors/monarch-money/attribution-service';
import { FinanceManagerConnector } from '@/lib/connectors/monarch-money';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { MonarchBridgeError } from '@/lib/connectors/monarch-money/client';
import { isDemoMode } from '@/lib/mode';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { requestFinanceAttributionRetry } from '@/lib/finance/attribution-retry';
import { ApiErrors } from '@/lib/api-error';

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    action: z.literal('manual-resolve'),
    kidId: z.string().trim().min(1).max(128).nullable(),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    action: z.literal('dismiss'),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    action: z.literal('retry'),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    action: z.literal('update-category'),
    categoryId: z.string().trim().min(1).max(200),
  }).strict(),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; exceptionId: string }> },
) {
  const actorType = trustedFinanceMutationActor(request);
  if (!actorType) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = requestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: 'A valid exception action is required' }, { status: 400 });
    }
    const { id, exceptionId } = await params;
    if (body.data.action === 'update-category') {
      const transactionId = await resolveAttributionExceptionTransactionId(id, exceptionId);
      if (isDemoMode()) {
        const updated = await (
          await getWorkerPersistenceRepositories()
        ).finance.web.updateDemoCategory({
          connectorId: id,
          transactionId,
          categoryId: body.data.categoryId,
        });
        if (!updated) {
          return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }
        return NextResponse.json({
          status: 'updated',
          exceptionId,
          categoryId: body.data.categoryId,
        });
      }
      const connector = new FinanceManagerConnector();
      await connector.initialize(await getPersistedFinanceConnectorConfig(id));
      const result = await connector.updateCategory(
        transactionId,
        body.data.categoryId,
        request.headers.get('idempotency-key')?.trim() || undefined,
        request.signal,
      );
      return NextResponse.json({
        ...result,
        exceptionId,
        categoryId: body.data.categoryId,
      });
    }
    const result = await actOnAttributionException({
      connectorId: id,
      exceptionId,
      action: body.data.action,
      kidId: body.data.action === 'manual-resolve' ? body.data.kidId : undefined,
      expectedUpdatedAt: body.data.expectedUpdatedAt,
      idempotencyKey: request.headers.get('idempotency-key'),
      actorType,
    });
    // Only after the exception transition has committed, and never for an
    // idempotent replay.
    if (result.retryScheduled) {
      requestFinanceAttributionRetry(id);
    }
    return NextResponse.json({
      status: result.status,
      exceptionId,
    });
  } catch (error) {
    if (error instanceof FinanceAttributionMutationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
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
    return ApiErrors.internal('Failed to update attribution exception', error);
  }
}
