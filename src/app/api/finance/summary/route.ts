import { NextResponse } from 'next/server';
import db from '@/db';
import { financeTransactions, kidProfiles } from '@/db/schema';
import { and, eq, gte, lte, sql, isNotNull } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || getDefaultStartDate();
  const endDate = searchParams.get('endDate') || getLocalToday();
  const connectorId = searchParams.get('connectorId');
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate) || startDate > endDate) {
    return NextResponse.json({ error: 'A valid ascending YYYY-MM-DD range is required' }, { status: 400 });
  }

  try {
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const conditions = [
      eq(financeTransactions.connectorInstanceId, config.id),
      eq(financeTransactions.lifecycleStatus, 'active'),
      gte(financeTransactions.date, startDate),
      lte(financeTransactions.date, endDate),
    ];

    const where = and(...conditions);

    // Total spending
    const totalResult = await db.select({
      total: sql<number>`COALESCE(SUM(ABS(${financeTransactions.amount})), 0)`,
      count: sql<number>`COUNT(*)`,
    })
      .from(financeTransactions)
      .where(where);

    // Per-category breakdown
    const byCategory = await db.select({
      category: financeTransactions.confirmedCategory,
      total: sql<number>`COALESCE(SUM(ABS(${financeTransactions.amount})), 0)`,
      count: sql<number>`COUNT(*)`,
    })
      .from(financeTransactions)
      .where(where)
      .groupBy(financeTransactions.confirmedCategory)
      .orderBy(sql`SUM(ABS(${financeTransactions.amount})) DESC`);

    // Per-kid breakdown (single GROUP BY instead of N queries)
    const kids = await db.select().from(kidProfiles);
    const kidSpendingRows = await db.select({
      kidId: financeTransactions.assignedKidId,
      total: sql<number>`COALESCE(SUM(ABS(${financeTransactions.amount})), 0)`,
      count: sql<number>`COUNT(*)`,
    })
      .from(financeTransactions)
      .where(
        and(
          ...conditions,
          isNotNull(financeTransactions.assignedKidId)
        )
      )
      .groupBy(financeTransactions.assignedKidId);

    const kidSpendingMap = new Map(
      kidSpendingRows.map(r => [r.kidId, { total: r.total, count: r.count }])
    );

    const byKid = kids.map((kid) => ({
      kidId: kid.id,
      kidName: kid.name,
      total: kidSpendingMap.get(kid.id)?.total || 0,
      transactionCount: kidSpendingMap.get(kid.id)?.count || 0,
    }));

    return NextResponse.json({
      period: { startDate, endDate },
      total: totalResult[0]?.total || 0,
      transactionCount: totalResult[0]?.count || 0,
      byCategory: byCategory.map(c => ({
        category: c.category,
        total: c.total,
        count: c.count,
      })),
      byKid,
    });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to generate summary', error);
  }
}

function getDefaultStartDate(): string {
  const today = getLocalToday();
  // Return first day of current month
  return today.slice(0, 8) + '01';
}
