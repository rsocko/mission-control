import { beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '@/db';
import {
  consumeHoustonFinanceApproval,
  InvalidHoustonFinanceApprovalError,
  persistHoustonFinanceApproval,
} from '@/lib/ai/finance-approval-store';

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

beforeEach(() => {
  sqlite.prepare('DELETE FROM houston_finance_pending_approvals').run();
});

describe('Houston persisted finance approvals', () => {
  it('atomically consumes the server-owned proposal exactly once', () => {
    persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    expect(consumeHoustonFinanceApproval(approval)).toEqual(approval);
    expect(() => consumeHoustonFinanceApproval(approval))
      .toThrow(InvalidHoustonFinanceApprovalError);
  });

  it('rejects changed arguments without consuming the proposal', () => {
    persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
    });

    expect(() => consumeHoustonFinanceApproval({
      ...approval,
      toolInput: { ...mutationInput, kidName: 'Mallory' },
    })).toThrow(InvalidHoustonFinanceApprovalError);
    expect(consumeHoustonFinanceApproval(approval)).toEqual(approval);
  });

  it('rejects expired proposals', () => {
    const issuedAt = new Date('2026-08-29T12:00:00.000Z');
    persistHoustonFinanceApproval({
      ...approval,
      correlationId: 'invented-correlation',
      now: issuedAt,
    });

    expect(() => consumeHoustonFinanceApproval({
      ...approval,
      now: new Date('2026-08-29T13:00:00.001Z'),
    })).toThrow(InvalidHoustonFinanceApprovalError);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM houston_finance_pending_approvals
      WHERE approval_id = ?
    `).get(approval.approvalId)).toEqual({ count: 0 });
  });

  it('allows identical persistence retries and rejects conflicting reuse', () => {
    const pending = {
      ...approval,
      correlationId: 'invented-correlation',
    };
    persistHoustonFinanceApproval(pending);
    persistHoustonFinanceApproval(pending);

    expect(() => persistHoustonFinanceApproval({
      ...pending,
      toolInput: { ...mutationInput, kidName: 'Mallory' },
    })).toThrow(InvalidHoustonFinanceApprovalError);
    expect(consumeHoustonFinanceApproval(approval)).toEqual(approval);
  });
});
