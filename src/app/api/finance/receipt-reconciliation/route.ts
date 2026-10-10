import { NextResponse } from 'next/server';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import {
  OwlReceiptReconciliationAdapter,
  ReceiptReconciliationAdapterError,
} from '@/lib/receipt-reconciliation/server-adapter';

export async function GET(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 });
  }
  const rawOffset = new URL(request.url).searchParams.get('offset') ?? '0';
  if (!/^\d{1,7}$/.test(rawOffset)) {
    return NextResponse.json({ error: 'Invalid receipt review offset', code: 'invalid_offset' }, { status: 400 });
  }
  try {
    return NextResponse.json(await new OwlReceiptReconciliationAdapter().list(Number(rawOffset)));
  } catch (error) {
    if (error instanceof ReceiptReconciliationAdapterError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'Receipt reconciliation could not be loaded.', code: 'receipt_reconciliation_failed' },
      { status: 500 },
    );
  }
}
