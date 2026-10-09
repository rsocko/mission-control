import { NextRequest, NextResponse } from 'next/server';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';
import {
  FinanceAttributionReadinessError,
  getFinanceAttributionPolicyReadiness,
  previewFinanceAttributionPolicy,
  updateFinanceAttributionPolicySelection,
} from '@/lib/connectors/monarch-money/attribution-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof FinanceAttributionReadinessError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json(
    { error: 'finance_attribution_readiness_unavailable' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  try {
    return NextResponse.json(await getFinanceAttributionPolicyReadiness(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  try {
    return NextResponse.json(await previewFinanceAttributionPolicy(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => null) as unknown;
  if (
    typeof body !== 'object'
    || body === null
    || !Object.prototype.hasOwnProperty.call(body, 'pinnedPolicyVersion')
  ) {
    return NextResponse.json(
      { error: 'attribution_policy_pin_invalid' },
      { status: 400 },
    );
  }
  const pinnedPolicyVersion = (body as Record<string, unknown>).pinnedPolicyVersion;
  if (
    pinnedPolicyVersion !== null
    && (!Number.isSafeInteger(pinnedPolicyVersion) || Number(pinnedPolicyVersion) < 1)
  ) {
    return NextResponse.json(
      { error: 'attribution_policy_pin_invalid' },
      { status: 400 },
    );
  }
  const { id } = await context.params;
  try {
    return NextResponse.json(await updateFinanceAttributionPolicySelection(
      id,
      pinnedPolicyVersion === null ? null : Number(pinnedPolicyVersion),
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
