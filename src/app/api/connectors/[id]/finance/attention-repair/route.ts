import { NextResponse } from 'next/server';
import { z } from 'zod';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import {
  FINANCE_ATTENTION_REPAIR_CONFIRMATION,
  FinanceAttentionRepairError,
  repairAttributionNotConfiguredAttention,
} from '@/lib/finance/attention-repair';

const requestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('dry-run'),
  }).strict(),
  z.object({
    mode: z.literal('apply'),
    dryRunId: z.string().uuid(),
    confirmation: z.literal(FINANCE_ATTENTION_REPAIR_CONFIRMATION),
  }).strict(),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actorType = trustedFinanceMutationActor(request);
  if (!actorType) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: 'Invalid finance attention repair request', code: 'invalid_repair_request' },
      { status: 400 },
    );
  }
  try {
    const connectorId = (await params).id;
    const result = await repairAttributionNotConfiguredAttention({
      connectorId,
      mode: body.data.mode,
      actorType,
      idempotencyKey: request.headers.get('idempotency-key'),
      dryRunId: body.data.mode === 'apply' ? body.data.dryRunId : undefined,
      confirmation: body.data.mode === 'apply' ? body.data.confirmation : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FinanceAttentionRepairError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: 'Finance attention projection repair failed', code: 'finance_attention_repair_failed' },
      { status: 500 },
    );
  }
}
