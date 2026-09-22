import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresFinanceInsightPersistence } from '@/db/postgres/repositories/finance-insights-repositories';
import { financeConnectorScopedReference } from '@/lib/connectors/monarch-money/identity';

// Pure/structural coverage for the PostgreSQL `readOperationalProjectionFacts`
// port implementation: there is no existing PostgreSQL "insights" integration
// harness (unlike Layer 5A's `finance-worker-persistence.contract.ts`), so —
// per this fix's scope — this exercises the adapter's SQL shape and its
// normalization/scoping/JSON-boolean handling against a mocked `Pool` rather
// than a live database, staying focused and independent of
// `tests/connectors/finance-insight-publication.test.ts`.

const CONNECTOR_ID = 'finance-projection-facts-postgres-test';
const IDENTITY_NAMESPACE = 'a'.repeat(64);

function scoped(kind: string, upstreamId: string): string {
  return financeConnectorScopedReference(IDENTITY_NAMESPACE, kind, upstreamId);
}

function createMockPool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM connector_configs')) {
      return { rows: [{ credentials: { identityNamespace: IDENTITY_NAMESPACE } }] };
    }
    if (sql.includes('FROM finance_transactions')) {
      return {
        rows: [{
          sourceRef: 'upstream-txn-1',
          occurredOn: '2024-01-15',
          amount: -12.345,
          merchantName: '  Invented   Merchant \u0007 Name  ',
          categoryRef: 'upstream-category-1',
          accountRef: 'upstream-account-1',
          isPending: true,
          tagReferences: ['upstream-tag-1', 'upstream-tag-1', 'upstream-tag-2'],
        }],
      };
    }
    if (sql.includes('FROM finance_recurring_obligations')) {
      return {
        rows: [{
          sourceRef: 'upstream-recurring-1',
          merchant: 'Invented Recurring Merchant',
          amount: 42,
          frequency: 'MONTHLY',
          nextDate: '2024-02-15',
          categoryRef: 'upstream-category-1',
          accountRef: 'upstream-account-1',
        }],
      };
    }
    if (sql.includes('FROM finance_categories')) {
      return {
        rows: [{
          sourceRef: 'upstream-category-1',
          name: 'Invented Category',
          groupRef: 'upstream-group-1',
          active: true,
        }],
      };
    }
    if (sql.includes('FROM finance_accounts')) {
      return { rows: [{ sourceRef: 'upstream-account-1', type: 'Checking Account', active: true }] };
    }
    if (sql.includes('FROM finance_tags')) {
      return {
        rows: [
          { sourceRef: 'upstream-tag-1', name: 'Invented Tag One', active: true },
          { sourceRef: 'upstream-tag-2', name: 'Invented Tag Two', active: true },
        ],
      };
    }
    throw new Error(`Unexpected query in test mock: ${sql} ${JSON.stringify(params)}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('PostgreSQL finance insight projection facts (structural)', () => {
  it('reads and normalizes every operational fact kind scoped to the identity namespace', async () => {
    const { pool } = createMockPool();
    const persistence = createPostgresFinanceInsightPersistence(pool);

    const facts = await persistence.projection.readOperationalProjectionFacts(
      CONNECTOR_ID,
      '2024-01-01',
    );

    expect(facts.transaction).toHaveLength(1);
    const [transactionFact] = facts.transaction;
    expect(transactionFact).toMatchObject({
      sourceRef: scoped('transaction', 'upstream-txn-1'),
      occurredOn: '2024-01-15',
      amountMinor: -1234,
      merchantName: 'Invented Merchant Name',
      categoryRef: scoped('category', 'upstream-category-1'),
      accountRef: scoped('account', 'upstream-account-1'),
      isPending: true,
      recurringRef: null,
    });
    expect(transactionFact!.tagRefs).toEqual(
      [scoped('tag', 'upstream-tag-1'), scoped('tag', 'upstream-tag-2')].sort(),
    );

    expect(facts.recurring).toEqual([{
      sourceRef: scoped('recurring', 'upstream-recurring-1'),
      displayName: 'Invented Recurring Merchant',
      amountMinor: 4200,
      cadence: 'monthly',
      nextDate: '2024-02-15',
      categoryRef: scoped('category', 'upstream-category-1'),
      accountRef: scoped('account', 'upstream-account-1'),
      active: true,
    }]);

    expect(facts.category).toEqual([{
      sourceRef: scoped('category', 'upstream-category-1'),
      displayName: 'Invented Category',
      groupRef: scoped('category-group', 'upstream-group-1'),
      active: true,
    }]);

    expect(facts.account).toEqual([{
      sourceRef: scoped('account', 'upstream-account-1'),
      accountType: 'checking',
      active: true,
    }]);

    expect(facts.tag).toEqual([
      { sourceRef: scoped('tag', 'upstream-tag-1'), displayName: 'Invented Tag One', active: true },
      { sourceRef: scoped('tag', 'upstream-tag-2'), displayName: 'Invented Tag Two', active: true },
    ].sort((left, right) => (left.sourceRef < right.sourceRef ? -1 : 1)));
  });

  it('restricts querying to a single kind when onlyKind is provided', async () => {
    const { pool, query } = createMockPool();
    const persistence = createPostgresFinanceInsightPersistence(pool);

    const facts = await persistence.projection.readOperationalProjectionFacts(
      CONNECTOR_ID,
      '2024-01-01',
      'account',
    );

    expect(facts.transaction).toEqual([]);
    expect(facts.recurring).toEqual([]);
    expect(facts.category).toEqual([]);
    expect(facts.account).toHaveLength(1);
    expect(facts.tag).toEqual([]);

    const queriedTables = query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => /FROM finance_(transactions|recurring_obligations|categories|accounts|tags)/.test(sql));
    expect(queriedTables).toHaveLength(1);
    expect(queriedTables[0]).toContain('FROM finance_accounts');
  });

  it('passes the optional transactionEnd bound using the nullable-parameter SQL pattern', async () => {
    const { pool, query } = createMockPool();
    const persistence = createPostgresFinanceInsightPersistence(pool);

    await persistence.projection.readOperationalProjectionFacts(
      CONNECTOR_ID,
      '2024-01-01',
      'transaction',
      '2024-01-31',
    );

    const [, params] = query.mock.calls.find(
      (call) => String(call[0]).includes('FROM finance_transactions'),
    )!;
    expect(params).toEqual([CONNECTOR_ID, '2024-01-01', '2024-01-31']);

    await persistence.projection.readOperationalProjectionFacts(CONNECTOR_ID, '2024-01-01', 'transaction');
    const [, unboundedParams] = query.mock.calls
      .filter((call) => String(call[0]).includes('FROM finance_transactions'))
      .at(-1)!;
    expect(unboundedParams).toEqual([CONNECTOR_ID, '2024-01-01', null]);
  });
});
