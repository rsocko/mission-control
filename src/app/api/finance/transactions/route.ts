import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const kidId = searchParams.get('kidId');
  const category = searchParams.get('category');
  const triageStatus = searchParams.get('triageStatus');
  const connectorId = searchParams.get('connectorId');
  const parsedLimit = Number(searchParams.get('limit') ?? 100);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
    return NextResponse.json({ error: 'limit must be an integer from 1 to 500' }, { status: 400 });
  }
  if ((startDate && !DATE_PATTERN.test(startDate)) || (endDate && !DATE_PATTERN.test(endDate))) {
    return NextResponse.json({ error: 'Dates must use YYYY-MM-DD' }, { status: 400 });
  }
  if (startDate && endDate && startDate > endDate) {
    return NextResponse.json({ error: 'startDate must not be after endDate' }, { status: 400 });
  }

  try {
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const transactions = await (
      await getWorkerPersistenceRepositories()
    ).finance.web.listTransactions({
      connectorId: config.id,
      startDate,
      endDate,
      kidId,
      category,
      triageStatus,
      limit: parsedLimit,
    });

    return NextResponse.json({ transactions, total: transactions.length });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to fetch transactions', error);
  }
}
