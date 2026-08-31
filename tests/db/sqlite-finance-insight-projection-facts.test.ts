import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-projection-facts-'));
const databasePath = join(tempDirectory, 'projection-facts.db');
let sqlite: Database.Database;
let loadFinanceInsightProjectionFacts:
  typeof import('@/db/persistence/sqlite-finance-insight-projection-facts')['loadFinanceInsightProjectionFacts'];

const CONNECTOR_ID = 'finance-projection-facts-test';

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  sqlite = (await import('@/db')).sqlite;
  ({ loadFinanceInsightProjectionFacts } = await import(
    '@/db/persistence/sqlite-finance-insight-projection-facts'
  ));
});

beforeEach(() => {
  for (const table of [
    'finance_transactions',
    'finance_recurring_obligations',
    'finance_categories',
    'finance_accounts',
    'finance_tags',
    'connector_configs',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', ?, 1, 'poll', '{}', ?, '{}', '[]', ?, ?)
  `).run(
    CONNECTOR_ID,
    CONNECTOR_ID,
    JSON.stringify({ identityNamespace: 'a'.repeat(64) }),
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

function insertTransaction(overrides: {
  id: string;
  upstreamTransactionId: string;
  date: string;
  amount: number;
  merchantName?: string | null;
  categoryId?: string | null;
  accountId?: string | null;
  isPending?: boolean;
  tagReferences?: string[];
}) {
  sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, category_id, account_id, is_pending, tag_references,
      lifecycle_status, source_fingerprint, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', ?)
  `).run(
    overrides.id,
    CONNECTOR_ID,
    overrides.upstreamTransactionId,
    overrides.date,
    overrides.amount,
    overrides.merchantName ?? null,
    overrides.categoryId ?? null,
    overrides.accountId ?? null,
    overrides.isPending ? 1 : 0,
    JSON.stringify(overrides.tagReferences ?? []),
    overrides.date,
  );
}

function insertRecurring(overrides: {
  id: string;
  upstreamRecurringId: string;
  merchant: string;
  amount: number;
  frequency: string;
  nextExpectedDate?: string | null;
  upstreamCategoryId?: string | null;
  upstreamAccountId?: string | null;
  isCurrent?: boolean;
}) {
  sqlite.prepare(`
    INSERT INTO finance_recurring_obligations (
      id, connector_id, generation_id, upstream_recurring_id, merchant, amount,
      frequency, next_expected_date, upstream_account_id, upstream_category_id,
      is_current, source_as_of, created_at
    ) VALUES (?, ?, 'generation-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id,
    CONNECTOR_ID,
    overrides.upstreamRecurringId,
    overrides.merchant,
    overrides.amount,
    overrides.frequency,
    overrides.nextExpectedDate ?? null,
    overrides.upstreamAccountId ?? null,
    overrides.upstreamCategoryId ?? null,
    overrides.isCurrent === false ? 0 : 1,
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
}

function insertCategory(overrides: {
  id: string;
  upstreamCategoryId: string;
  name: string;
  upstreamGroupId?: string | null;
  isActive?: boolean;
}) {
  sqlite.prepare(`
    INSERT INTO finance_categories (
      id, connector_id, upstream_category_id, name, upstream_group_id,
      is_active, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id,
    CONNECTOR_ID,
    overrides.upstreamCategoryId,
    overrides.name,
    overrides.upstreamGroupId ?? null,
    overrides.isActive === false ? 0 : 1,
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
}

function insertAccount(overrides: {
  id: string;
  upstreamAccountId: string;
  type: string;
  isActive?: boolean;
}) {
  sqlite.prepare(`
    INSERT INTO finance_accounts (
      id, connector_id, upstream_account_id, display_name, type, is_active,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id,
    CONNECTOR_ID,
    overrides.upstreamAccountId,
    overrides.type,
    overrides.type,
    overrides.isActive === false ? 0 : 1,
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
}

function insertTag(overrides: { id: string; upstreamTagId: string; name: string; isActive?: boolean }) {
  sqlite.prepare(`
    INSERT INTO finance_tags (
      id, connector_id, upstream_tag_id, name, is_active, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id,
    CONNECTOR_ID,
    overrides.upstreamTagId,
    overrides.name,
    overrides.isActive === false ? 0 : 1,
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
}

describe.sequential('SQLite finance insight projection facts', () => {
  it('reads and normalizes every operational fact kind scoped to the identity namespace', () => {
    insertTransaction({
      id: 'txn-1',
      upstreamTransactionId: 'upstream-txn-1',
      date: '2024-01-15',
      amount: -12.345,
      merchantName: '  Invented   Merchant \u0007 Name  ',
      categoryId: 'upstream-category-1',
      accountId: 'upstream-account-1',
      isPending: true,
      tagReferences: ['upstream-tag-1', 'upstream-tag-1', 'upstream-tag-2'],
    });
    insertRecurring({
      id: 'rec-1',
      upstreamRecurringId: 'upstream-recurring-1',
      merchant: 'Invented Recurring Merchant',
      amount: 42,
      frequency: 'MONTHLY',
      nextExpectedDate: '2024-02-15',
      upstreamCategoryId: 'upstream-category-1',
      upstreamAccountId: 'upstream-account-1',
    });
    insertCategory({
      id: 'cat-1',
      upstreamCategoryId: 'upstream-category-1',
      name: 'Invented Category',
      upstreamGroupId: 'upstream-group-1',
    });
    insertAccount({ id: 'acc-1', upstreamAccountId: 'upstream-account-1', type: 'Checking Account' });
    insertTag({ id: 'tag-1', upstreamTagId: 'upstream-tag-1', name: 'Invented Tag One' });
    insertTag({ id: 'tag-2', upstreamTagId: 'upstream-tag-2', name: 'Invented Tag Two' });

    const facts = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01');

    expect(facts.transaction).toHaveLength(1);
    const [transactionFact] = facts.transaction;
    expect(transactionFact).toMatchObject({
      occurredOn: '2024-01-15',
      amountMinor: -1234,
      merchantName: 'Invented Merchant Name',
      isPending: true,
      recurringRef: null,
    });
    expect(transactionFact!.sourceRef).toMatch(/^transaction-v1:[A-Za-z0-9_-]{43}$/);
    expect(transactionFact!.categoryRef).toMatch(/^category-v1:[A-Za-z0-9_-]{43}$/);
    expect(transactionFact!.accountRef).toMatch(/^account-v1:[A-Za-z0-9_-]{43}$/);
    expect(transactionFact!.tagRefs).toHaveLength(2);
    expect(transactionFact!.tagRefs.every((ref) => /^tag-v1:[A-Za-z0-9_-]{43}$/.test(ref))).toBe(true);
    expect(new Set(transactionFact!.tagRefs).size).toBe(2);

    expect(facts.recurring).toHaveLength(1);
    expect(facts.recurring[0]).toMatchObject({
      displayName: 'Invented Recurring Merchant',
      amountMinor: 4200,
      cadence: 'monthly',
      nextDate: '2024-02-15',
      active: true,
    });
    expect(facts.recurring[0]!.categoryRef).toBe(transactionFact!.categoryRef);
    expect(facts.recurring[0]!.accountRef).toBe(transactionFact!.accountRef);

    expect(facts.category).toHaveLength(1);
    expect(facts.category[0]).toMatchObject({ displayName: 'Invented Category', active: true });
    expect(facts.category[0]!.sourceRef).toBe(transactionFact!.categoryRef);
    expect(facts.category[0]!.groupRef).toMatch(/^category-group-v1:[A-Za-z0-9_-]{43}$/);

    expect(facts.account).toHaveLength(1);
    expect(facts.account[0]).toMatchObject({ accountType: 'checking', active: true });
    expect(facts.account[0]!.sourceRef).toBe(transactionFact!.accountRef);

    expect(facts.tag).toHaveLength(2);
    expect(facts.tag.map((tag) => tag.displayName).sort()).toEqual([
      'Invented Tag One',
      'Invented Tag Two',
    ]);
    expect(facts.tag.every((tag) => tag.active)).toBe(true);
  });

  it('scopes identical upstream references identically across repeated reads', () => {
    insertTransaction({
      id: 'txn-2',
      upstreamTransactionId: 'upstream-txn-2',
      date: '2024-01-16',
      amount: 5,
    });

    const first = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01');
    const second = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01');

    expect(first.transaction[0]!.sourceRef).toBe(second.transaction[0]!.sourceRef);
  });

  it('restricts the result to a single kind when onlyKind is provided', () => {
    insertTransaction({
      id: 'txn-3',
      upstreamTransactionId: 'upstream-txn-3',
      date: '2024-01-17',
      amount: 1,
    });
    insertAccount({ id: 'acc-2', upstreamAccountId: 'upstream-account-2', type: 'Savings' });

    const onlyTransaction = loadFinanceInsightProjectionFacts(
      sqlite,
      CONNECTOR_ID,
      '2024-01-01',
      'transaction',
    );
    expect(onlyTransaction.transaction).toHaveLength(1);
    expect(onlyTransaction.recurring).toEqual([]);
    expect(onlyTransaction.category).toEqual([]);
    expect(onlyTransaction.account).toEqual([]);
    expect(onlyTransaction.tag).toEqual([]);

    const onlyAccount = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01', 'account');
    expect(onlyAccount.account).toHaveLength(1);
    expect(onlyAccount.account[0]).toMatchObject({ accountType: 'savings' });
    expect(onlyAccount.transaction).toEqual([]);
  });

  it('bounds transaction reads to the inclusive [transactionStart, transactionEnd] window', () => {
    insertTransaction({
      id: 'txn-before',
      upstreamTransactionId: 'upstream-txn-before',
      date: '2023-12-31',
      amount: 1,
    });
    insertTransaction({
      id: 'txn-in-range',
      upstreamTransactionId: 'upstream-txn-in-range',
      date: '2024-01-10',
      amount: 1,
    });
    insertTransaction({
      id: 'txn-after',
      upstreamTransactionId: 'upstream-txn-after',
      date: '2024-02-01',
      amount: 1,
    });

    const noEnd = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01', 'transaction');
    expect(noEnd.transaction.map((fact) => fact.occurredOn).sort()).toEqual([
      '2024-01-10',
      '2024-02-01',
    ]);

    const bounded = loadFinanceInsightProjectionFacts(
      sqlite,
      CONNECTOR_ID,
      '2024-01-01',
      'transaction',
      '2024-01-31',
    );
    expect(bounded.transaction.map((fact) => fact.occurredOn)).toEqual(['2024-01-10']);
  });

  it('falls back to a normalized placeholder merchant name when the source value is blank', () => {
    insertTransaction({
      id: 'txn-blank-merchant',
      upstreamTransactionId: 'upstream-txn-blank-merchant',
      date: '2024-01-20',
      amount: 1,
      merchantName: '   ',
    });

    const facts = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01', 'transaction');

    expect(facts.transaction[0]!.merchantName).toBe('Unknown merchant');
  });

  it.each([
    ['weekly', 'weekly'],
    ['bi-weekly', 'biweekly'],
    ['fortnightly', 'biweekly'],
    ['Monthly', 'monthly'],
    ['quarterly', 'quarterly'],
    ['semi-annual', 'semiannual'],
    ['annually', 'annual'],
    ['sporadic', 'unknown'],
  ])('maps recurring frequency %s to cadence %s', (frequency, expectedCadence) => {
    insertRecurring({
      id: `rec-cadence-${frequency}`,
      upstreamRecurringId: `upstream-recurring-cadence-${frequency}`,
      merchant: 'Cadence merchant',
      amount: 10,
      frequency,
    });

    const facts = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01', 'recurring');

    expect(facts.recurring[0]!.cadence).toBe(expectedCadence);
  });

  it.each([
    ['Checking Account', 'checking'],
    ['High-Yield Savings', 'savings'],
    ['Rewards Credit Card', 'credit'],
    ['Cash on hand', 'cash'],
    ['Auto Loan', 'loan'],
    ['Mortgage', 'loan'],
    ['Brokerage Investment', 'investment'],
    ['Something else entirely', 'other'],
  ])('maps account type %s to %s', (type, expectedAccountType) => {
    insertAccount({ id: `acc-type-${type}`, upstreamAccountId: `upstream-account-type-${type}`, type });

    const facts = loadFinanceInsightProjectionFacts(sqlite, CONNECTOR_ID, '2024-01-01', 'account');

    expect(facts.account[0]!.accountType).toBe(expectedAccountType);
  });
});
