import { NextResponse } from 'next/server';
import db from '@/db';
import { kidProfiles, financeTransactions } from '@/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';

export async function GET(request: Request) {
  try {
    const connectorId = new URL(request.url).searchParams.get('connectorId');
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const kids = await db.select().from(kidProfiles);

    // Calculate current month spending per kid
    const today = getLocalToday();
    const monthStart = today.slice(0, 7) + '-01';

    const kidsWithSpending = await Promise.all(
      kids.map(async (kid) => {
        const spending = await db.select({
          total: sql<number>`COALESCE(SUM(ABS(${financeTransactions.amount})), 0)`,
        })
          .from(financeTransactions)
          .where(
            and(
              eq(financeTransactions.assignedKidId, kid.id),
              eq(financeTransactions.connectorInstanceId, config.id),
              eq(financeTransactions.lifecycleStatus, 'active'),
              gte(financeTransactions.date, monthStart)
            )
          );

        return {
          ...kid,
          currentMonthSpending: spending[0]?.total || 0,
        };
      })
    );

    return NextResponse.json({ kids: kidsWithSpending });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to fetch kids', error);
  }
}
