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
  query = next;
}

export function clearFinanceTransactionQuery(): void {
  query = null;
}

export async function queryFinanceTransactions(
  connectorId: string,
  filters: FinanceTransactionFilters = {},
): Promise<Array<Record<string, unknown>>> {
  if (!query) {
    throw new Error('Finance transaction queries are unavailable for the selected backend');
  }
  return query.list(connectorId, filters);
}
