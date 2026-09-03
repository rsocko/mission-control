import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export interface FinanceTransactionFilters {
  startDate?: string;
  endDate?: string;
  kidId?: string;
  category?: string;
  triageStatus?: string;
  limit?: number;
}

export interface FinanceTransactionQuery {
  list(
    connectorId: string,
    filters?: FinanceTransactionFilters,
  ): Promise<Array<Record<string, unknown>>>;
}

let query: FinanceTransactionQuery | null = null;

export function registerFinanceTransactionQuery(next: FinanceTransactionQuery): void {
  assertCanRegisterFinanceTransactionQuery(next);
  query = next;
}

export function assertCanRegisterFinanceTransactionQuery(
  next: FinanceTransactionQuery,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (query && query !== next) {
    throw new Error('Finance transaction query is already selected');
  }
}

export function clearFinanceTransactionQuery(
  expectedQuery?: FinanceTransactionQuery,
): void {
  if (expectedQuery && query !== expectedQuery) return;
  query = null;
}

export async function queryFinanceTransactions(
  connectorId: string,
  filters: FinanceTransactionFilters = {},
): Promise<Array<Record<string, unknown>>> {
  assertPersistenceCompositionAccessAllowed();
  if (!query) {
    throw new Error('Finance transaction queries are unavailable for the selected backend');
  }
  return query.list(connectorId, filters);
}
