import { beforeEach, describe, expect, it } from 'vitest';
import type { FinanceWebPersistence } from '@/db/persistence/finance-web';

export const FINANCE_WEB_CONNECTOR_ID = 'finance-web-contract';
export const FINANCE_WEB_TRANSACTION_ID = 'finance:web-contract:transaction';
export const FINANCE_WEB_BASE_TIME = '2026-08-20T12:00:00.000Z';

export interface FinanceWebContractHarness {
  persistence: FinanceWebPersistence;
  reset(): Promise<void>;
  seed(): Promise<void>;
  notification(id: string): Promise<{
    state: string;
    readState: string;
    disposition: string;
  } | null>;
  transactionCategory(): Promise<string | null>;
  mutation(idempotencyKey: string): Promise<{
    status: string;
    attemptCount: number;
  } | null>;
}

const expectedVersion = {
  sourceFingerprint: 'source-fingerprint',
  lastSeenAt: FINANCE_WEB_BASE_TIME,
  assignedKidId: 'finance-web-kid',
  confirmedCategory: null,
  manualDecidedAt: null,
  categoryName: 'Groceries',
};

export function describeFinanceWebPersistenceContract(
  label: string,
  createHarness: () => Promise<FinanceWebContractHarness>,
): void {
  describe(`${label} finance web persistence contract`, () => {
    let harness: FinanceWebContractHarness;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      await harness.seed();
    });

    it('preserves finance reads, filtering, aggregates, and operations ordering', async () => {
      const kids = await harness.persistence.listKidsWithSpending(
        FINANCE_WEB_CONNECTOR_ID,
        '2026-08-01',
      );
      expect(kids).toEqual([
        expect.objectContaining({
          id: 'finance-web-kid',
          name: 'Alex',
          currentMonthSpending: 25,
        }),
        expect.objectContaining({
          id: 'finance-web-kid-empty',
          name: 'Blair',
          currentMonthSpending: 25,
        }),
      ]);

      const transactions = await harness.persistence.listTransactions({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        kidId: 'finance-web-kid',
        category: null,
        triageStatus: 'pending',
        limit: 10,
      });
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        id: FINANCE_WEB_TRANSACTION_ID,
        amount: -25,
        attributionReasons: ['account-rule'],
        attributionRetryable: false,
        isPending: false,
        tags: ['Household'],
        tagReferences: ['tag-1'],
      });
      await expect(harness.persistence.listTransactions({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        startDate: '',
        endDate: '',
        kidId: '',
        category: '',
        triageStatus: '',
        limit: 10,
      })).resolves.toEqual([
        expect.objectContaining({ id: 'finance:web-contract:transaction-z' }),
        expect.objectContaining({ id: FINANCE_WEB_TRANSACTION_ID }),
      ]);

      await expect(harness.persistence.readSummary({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      })).resolves.toEqual({
        total: 50,
        transactionCount: 2,
        byCategory: [
          { category: null, total: 25, count: 1 },
          { category: 'Dining', total: 25, count: 1 },
        ],
        byKid: [
          { kidId: 'finance-web-kid', kidName: 'Alex', total: 25, transactionCount: 1 },
          { kidId: 'finance-web-kid-empty', kidName: 'Blair', total: 25, transactionCount: 1 },
        ],
      });

      const overview = await harness.persistence.readOperationsOverview(
        FINANCE_WEB_CONNECTOR_ID,
        FINANCE_WEB_BASE_TIME,
      );
      expect(overview).toMatchObject({
        connector: { id: FINANCE_WEB_CONNECTOR_ID, name: 'Finance web contract' },
        attention: {
          total: 2,
          pendingExceptions: 1,
          retryRequested: 0,
          failedWritebacks: 0,
          openAlerts: 1,
        },
        alerts: [
          { title: 'Needs action', summary: 'Review the transaction', level: 'action_needed' },
        ],
        subjects: [
          { kidId: 'finance-web-kid', name: 'Alex', policyStatus: 'current' },
        ],
      });
    });

    it('preserves finance notification filtering, ordering, and scoped dismissal', async () => {
      const all = await harness.persistence.listNotifications({
        type: null,
        level: null,
        inboxOnly: false,
        limit: 10,
        now: FINANCE_WEB_BASE_TIME,
      });
      expect(all.map((item) => item.id)).toEqual([
        'finance-web-notification-dismissed',
        'finance-web-notification-action',
      ]);
      await expect(harness.persistence.listNotifications({
        type: '',
        level: null,
        inboxOnly: false,
        limit: 10,
        now: FINANCE_WEB_BASE_TIME,
      })).resolves.toHaveLength(2);
      await expect(harness.persistence.listNotifications({
        type: null,
        level: null,
        inboxOnly: false,
        limit: -1,
        now: FINANCE_WEB_BASE_TIME,
      })).resolves.toHaveLength(2);

      const inbox = await harness.persistence.listNotifications({
        type: 'budget_warning',
        level: 'action_needed',
        inboxOnly: true,
        limit: 10,
        now: FINANCE_WEB_BASE_TIME,
      });
      expect(inbox.map((item) => item.id)).toEqual(['finance-web-notification-action']);

      await harness.persistence.dismissNotification(
        'finance-web-notification-action',
        '2026-08-20T12:01:00.000Z',
      );
      await expect(harness.notification('finance-web-notification-action')).resolves.toEqual({
        state: 'dismissed',
        readState: 'read',
        disposition: 'dismissed',
      });
      await harness.persistence.dismissNotification(
        'finance-web-notification-other',
        '2026-08-20T12:02:00.000Z',
      );
      await expect(harness.notification('finance-web-notification-other')).resolves.toEqual({
        state: 'unread',
        readState: 'unread',
        disposition: 'inbox',
      });
    });

    it('serializes category claims and fences completion and failure', async () => {
      const claim = await harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-claim',
        now: FINANCE_WEB_BASE_TIME,
        staleBefore: '2026-08-20T11:45:00.000Z',
        expectedTransactionVersion: expectedVersion,
      });
      expect(claim).toMatchObject({
        outcome: 'claimed',
        upstreamTransactionId: 'upstream-transaction',
      });
      if (claim.outcome !== 'claimed') throw new Error('Expected a category claim');

      await expect(harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'competing-claim',
        now: '2026-08-20T12:01:00.000Z',
        staleBefore: '2026-08-20T11:46:00.000Z',
      })).rejects.toMatchObject({ code: 'mutation_in_progress', retryable: true });

      await expect(harness.persistence.completeCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-claim',
        claimToken: 'stale-token',
        completedAt: '2026-08-20T12:02:00.000Z',
      })).resolves.toBe(false);
      await expect(harness.transactionCategory()).resolves.toBeNull();

      await expect(harness.persistence.completeCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-claim',
        claimToken: claim.claimToken,
        completedAt: '2026-08-20T12:03:00.000Z',
      })).resolves.toBe(true);
      await expect(harness.transactionCategory()).resolves.toBe('category-groceries');
      await expect(harness.mutation('category-claim')).resolves.toEqual({
        status: 'succeeded',
        attemptCount: 1,
      });

      await expect(harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-claim',
        now: '2026-08-20T12:04:00.000Z',
        staleBefore: '2026-08-20T11:49:00.000Z',
      })).resolves.toEqual({ outcome: 'replayed' });
      await expect(harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'different-category',
        idempotencyKey: 'category-claim',
        now: '2026-08-20T12:05:00.000Z',
        staleBefore: '2026-08-20T11:50:00.000Z',
      })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('fences failed category claims and permits stale recovery', async () => {
      const originalClaim = await harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-recovery',
        now: FINANCE_WEB_BASE_TIME,
        staleBefore: '2026-08-20T11:45:00.000Z',
      });
      if (originalClaim.outcome !== 'claimed') throw new Error('Expected a category claim');

      await expect(harness.persistence.failCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        idempotencyKey: 'category-recovery',
        claimToken: 'stale-token',
        errorCode: 'upstream_timeout',
        errorMessage: 'Finance provider timed out',
        failedAt: '2026-08-20T12:01:00.000Z',
      })).resolves.toBe(false);
      await expect(harness.mutation('category-recovery')).resolves.toEqual({
        status: 'processing',
        attemptCount: 1,
      });

      const recoveredClaim = await harness.persistence.claimCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        transactionId: FINANCE_WEB_TRANSACTION_ID,
        categoryId: 'category-groceries',
        idempotencyKey: 'category-recovery',
        now: '2026-08-20T12:20:00.000Z',
        staleBefore: '2026-08-20T12:05:00.000Z',
      });
      expect(recoveredClaim).toMatchObject({ outcome: 'claimed' });
      if (recoveredClaim.outcome !== 'claimed') throw new Error('Expected a recovered claim');

      await expect(harness.persistence.failCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        idempotencyKey: 'category-recovery',
        claimToken: originalClaim.claimToken,
        errorCode: 'upstream_timeout',
        errorMessage: 'Stale provider response',
        failedAt: '2026-08-20T12:21:00.000Z',
      })).resolves.toBe(false);
      await expect(harness.persistence.failCategoryUpdate({
        connectorId: FINANCE_WEB_CONNECTOR_ID,
        idempotencyKey: 'category-recovery',
        claimToken: recoveredClaim.claimToken,
        errorCode: 'upstream_timeout',
        errorMessage: 'Finance provider timed out',
        failedAt: '2026-08-20T12:22:00.000Z',
      })).resolves.toBe(true);
      await expect(harness.mutation('category-recovery')).resolves.toEqual({
        status: 'failed',
        attemptCount: 2,
      });
    });
  });
}
