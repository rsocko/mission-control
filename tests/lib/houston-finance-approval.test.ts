import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';

vi.unmock('drizzle-orm');

const mocks = vi.hoisted(() => ({
  finance: null as FinanceCorePersistence | null,
  sqliteCompatibilityAccess: vi.fn(),
}));

vi.mock('@/db', () => {
  const forbidden = new Proxy({}, {
    get() {
      mocks.sqliteCompatibilityAccess();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { sqlite: forbidden, db: forbidden, default: forbidden };
});

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => {
    if (!mocks.finance) throw new Error('Finance persistence is not registered');
    return { finance: mocks.finance };
  },
}));

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-houston-approval-'));
const databasePath = join(tempDirectory, 'houston-approval.db');
let sqlite: Database.Database;
let store: typeof import('@/lib/ai/finance-approval-store');

const mutationInput = {
  transactionRef: `txn_${'a'.repeat(43)}`,
  expected: {
    date: '2026-08-13',
    amount: -12.34,
    merchant: 'Invented Market',
    category: 'Groceries',
    kidName: null,
    stateToken: `state_${'b'.repeat(43)}`,
  },
  kidName: 'Avery',
};

const approval = {
  approvalId: 'invented-approval-id',
  toolCallId: 'invented-call-id',
  toolName: 'assignFinanceTransactionKid' as const,
  toolInput: mutationInput,
};

function pendingCount(): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM houston_finance_pending_approvals
    WHERE approval_id = ?
  `).get(approval.approvalId) as { count: number };
  return row.count;
}

beforeAll(async () => {
  sqlite = new Database(databasePath);
  sqlite.pragma('foreign_keys = ON');
  const { runOrderedDatabaseBootstrap } = await import('@/db/bootstrap/registry');
  runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  const { createSqliteFinanceWorkerPersistence } = await import(
    '@/db/persistence/sqlite-finance-worker-repositories'
  );
  mocks.finance = createSqliteFinanceWorkerPersistence(sqlite);
  store = await import('@/lib/ai/finance-approval-store');
});

afterAll(() => {
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM houston_finance_pending_approvals').run();
});

describe('Houston persisted finance approvals', () => {
  it('atomically consumes the server-owned proposal exactly once', async () => {
    await store.persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    await expect(store.consumeHoustonFinanceApproval(approval)).resolves.toEqual(approval);
    await expect(store.consumeHoustonFinanceApproval(approval))
      .rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
    expect(pendingCount()).toBe(0);
  });

  it('rejects changed arguments without consuming the proposal', async () => {
    await store.persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    await expect(store.consumeHoustonFinanceApproval({
      ...approval,
      toolInput: { ...mutationInput, kidName: 'Mallory' },
    })).rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
    expect(pendingCount()).toBe(1);
    await expect(store.consumeHoustonFinanceApproval(approval)).resolves.toEqual(approval);
  });

  it('rejects a mismatched tool call without consuming the proposal', async () => {
    await store.persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    await expect(store.consumeHoustonFinanceApproval({
      ...approval,
      toolCallId: 'other-call-id',
    })).rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
    expect(pendingCount()).toBe(1);
  });

  it('rejects expired proposals', async () => {
    const issuedAt = new Date('2026-08-29T12:00:00.000Z');
    await store.persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
      now: issuedAt,
    });

    await expect(store.consumeHoustonFinanceApproval({
      ...approval,
      now: new Date('2026-08-29T13:00:00.001Z'),
    })).rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
    expect(pendingCount()).toBe(0);
  });

  it('rejects an unknown approval identity', async () => {
    await expect(store.consumeHoustonFinanceApproval(approval))
      .rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
  });

  it('allows identical persistence retries and rejects conflicting reuse', async () => {
    const pending = {
      ...approval,
      correlationId: 'invented-correlation',
    };
    await store.persistHoustonFinanceApproval(pending);
    await store.persistHoustonFinanceApproval(pending);
    expect(pendingCount()).toBe(1);

    await expect(store.persistHoustonFinanceApproval({
      ...pending,
      toolInput: { ...mutationInput, kidName: 'Mallory' },
    })).rejects.toThrow(store.InvalidHoustonFinanceApprovalError);
    await expect(store.consumeHoustonFinanceApproval(approval)).resolves.toEqual(approval);
  });

  it('canonicalizes stored arguments so key order never changes identity', async () => {
    await store.persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    await expect(store.consumeHoustonFinanceApproval({
      ...approval,
      toolInput: {
        kidName: mutationInput.kidName,
        expected: {
          stateToken: mutationInput.expected.stateToken,
          kidName: mutationInput.expected.kidName,
          category: mutationInput.expected.category,
          merchant: mutationInput.expected.merchant,
          amount: mutationInput.expected.amount,
          date: mutationInput.expected.date,
        },
        transactionRef: mutationInput.transactionRef,
      },
    })).resolves.toEqual(approval);
  });

  it('never reaches SQLite compatibility persistence', () => {
    expect(mocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });
});
