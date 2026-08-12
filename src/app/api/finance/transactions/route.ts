import { NextResponse } from 'next/server';
import db from '@/db';
import { financeTransactions } from '@/db/schema';
import { and, gte, lte, eq, sql } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';

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
    const conditions = [
      eq(financeTransactions.connectorInstanceId, config.id),
      eq(financeTransactions.lifecycleStatus, 'active'),
    ];

    if (startDate) conditions.push(gte(financeTransactions.date, startDate));
    if (endDate) conditions.push(lte(financeTransactions.date, endDate));
    if (kidId) conditions.push(eq(financeTransactions.assignedKidId, kidId));
    if (category) conditions.push(eq(financeTransactions.confirmedCategory, category));
    if (triageStatus) conditions.push(eq(financeTransactions.triageStatus, triageStatus));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const transactions = await db.select()
      .from(financeTransactions)
      .where(where)
      .orderBy(sql`${financeTransactions.date} DESC`)
      .limit(parsedLimit);

    return NextResponse.json({ transactions, total: transactions.length });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to fetch transactions', error);
  }
}
