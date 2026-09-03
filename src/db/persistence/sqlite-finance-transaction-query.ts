import db from '@/db';
import { financeTransactions } from '@/db/schema';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  FinanceTransactionFilters,
  FinanceTransactionQuery,
} from '@/lib/connectors/monarch-money/transaction-query';

export const sqliteFinanceTransactionQuery: FinanceTransactionQuery = {
  async list(connectorId: string, filters: FinanceTransactionFilters = {}) {
    const conditions = [
      eq(financeTransactions.connectorInstanceId, connectorId),
      eq(financeTransactions.lifecycleStatus, 'active'),
    ];
    if (filters.startDate) conditions.push(gte(financeTransactions.date, filters.startDate));
    if (filters.endDate) conditions.push(lte(financeTransactions.date, filters.endDate));
    if (filters.kidId) conditions.push(eq(financeTransactions.assignedKidId, filters.kidId));
    if (filters.category) {
      conditions.push(eq(financeTransactions.confirmedCategory, filters.category));
    }
    if (filters.triageStatus) {
      conditions.push(eq(financeTransactions.triageStatus, filters.triageStatus));
    }
    const limit = typeof filters.limit === 'number'
      && Number.isSafeInteger(filters.limit)
      && filters.limit > 0
      ? Math.min(filters.limit, 500)
      : 100;
    const rows = await db.select()
      .from(financeTransactions)
      .where(and(...conditions))
      .orderBy(sql`${financeTransactions.date} DESC`)
      .limit(limit);
    return rows as Array<Record<string, unknown>>;
  },
};
