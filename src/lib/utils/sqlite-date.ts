import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Compare stored timestamps by instant rather than raw text. Connectors may
 * persist equivalent ISO timestamps with different precision or without `Z`.
 */
export function timestampGte(column: SQLWrapper, boundary: string): SQL {
  return sql`julianday(${column}) >= julianday(${boundary})`;
}

export function timestampLt(column: SQLWrapper, boundary: string): SQL {
  return sql`julianday(${column}) < julianday(${boundary})`;
}
