import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  applyManualAttributionDecision,
  FinanceAttributionMutationError,
} from '@/lib/connectors/monarch-money/attribution-service';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { ApiErrors } from '@/lib/api-error';

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign-kid'),
    kidId: z.string().trim().min(1).max(128),
    connectorId: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  z.object({
    action: z.literal('parent-expense'),
    kidId: z.null().optional(),
    connectorId: z.string().trim().min(1).max(200).optional(),
  }).strict(),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actorType = trustedFinanceMutationActor(request);
  if (!actorType) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'A valid manual decision is required' }, { status: 400 });
    }
    const config = await getPersistedFinanceConnectorConfig(parsed.data.connectorId);
    const result = await applyManualAttributionDecision({
      connectorId: config.id,
      transactionId: (await params).id,
      action: parsed.data.action,
      kidId: parsed.data.action === 'assign-kid' ? parsed.data.kidId : null,
      idempotencyKey: request.headers.get('idempotency-key'),
      actorType,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceAttributionMutationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to record manual attribution', error);
  }
}
