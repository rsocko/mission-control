import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  actOnAttributionException,
  FinanceAttributionMutationError,
} from '@/lib/connectors/monarch-money/attribution-service';
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
    const result = actOnAttributionException({
      connectorId: id,
      exceptionId,
      action: body.data.action,
      kidId: body.data.action === 'manual-resolve' ? body.data.kidId : undefined,
      expectedUpdatedAt: body.data.expectedUpdatedAt,
      idempotencyKey: request.headers.get('idempotency-key'),
      actorType,
    });
    if (body.data.action === 'retry') {
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
    return ApiErrors.internal('Failed to update attribution exception', error);
  }
}
