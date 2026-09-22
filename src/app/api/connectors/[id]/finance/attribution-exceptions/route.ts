import { NextResponse } from 'next/server';
import {
  FinanceAttributionMutationError,
  listAttributionExceptions,
} from '@/lib/connectors/monarch-money/attribution-service';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { ApiErrors } from '@/lib/api-error';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(await listAttributionExceptions((await params).id, {
      status: searchParams.get('status'),
      limit: searchParams.get('limit'),
      cursor: searchParams.get('cursor'),
    }));
  } catch (error) {
    if (error instanceof FinanceAttributionMutationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return ApiErrors.internal('Failed to list attribution exceptions', error);
  }
}
