import { describe, expect, it, vi } from 'vitest';

const mutationSpies = vi.hoisted(() => ({
  assign: vi.fn(),
  category: vi.fn(),
}));

vi.mock('@/lib/finance/houston-tools', () => ({
  HoustonFinanceToolError: class HoustonFinanceToolError extends Error {
    code = 'finance_unavailable';
  },
  getHouseholdFinanceSummary: vi.fn(),
  searchFinanceTransactions: vi.fn(),
  getPendingFinanceExceptions: vi.fn(),
  getKidSpending: vi.fn(),
  getFinanceObligations: vi.fn(),
  getFinanceConnectorHealth: vi.fn(),
  assignFinanceTransactionKid: mutationSpies.assign,
  updateFinanceTransactionCategory: mutationSpies.category,
}));

import { createHoustonTools } from '@/lib/ai/tools';
import { createFinanceMutationTools } from '@/lib/ai/tools/finance-tools';
import { HoustonToolApprovalConfigurationError } from '@/lib/ai/tool-approval-config';
import { excludeFinanceMutations } from '@/lib/ai/tool-safety';

type ToolExecute = (
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<unknown>;

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

describe('createHoustonTools finance mutation shape', () => {
  it('always includes both finance mutation tool keys, with or without a secret', () => {
    const withoutSecret = createHoustonTools(undefined);
    const withSecret = createHoustonTools('invented-approval-secret-at-least-32-bytes');

    // Fixed, non-union key set is required so TypeScript can infer a
    // consistent `toolsContext` shape for `generateText`/`streamText` in
    // chat.ts (see the comment on createFinanceMutationTools).
    expect(Object.keys(withoutSecret).sort()).toEqual(Object.keys(withSecret).sort());
    expect(withoutSecret).toHaveProperty('assignFinanceTransactionKid');
    expect(withoutSecret).toHaveProperty('updateFinanceTransactionCategory');
  });

  it('fails closed when a finance mutation tool executes without a configured secret', () => {
    const tools = createFinanceMutationTools(undefined);
    const execute = tools.assignFinanceTransactionKid.execute as unknown as ToolExecute;

    // `execute` throws synchronously (not a rejected promise) when no secret
    // is configured, so it must be invoked inside the assertion callback.
    expect(() => execute(mutationInput, { toolCallId: 'call-1' }))
      .toThrow(HoustonToolApprovalConfigurationError);
    expect(mutationSpies.assign).not.toHaveBeenCalled();

    const executeCategory = tools.updateFinanceTransactionCategory.execute as unknown as ToolExecute;
    expect(() => executeCategory(mutationInput, { toolCallId: 'call-2' }))
      .toThrow(HoustonToolApprovalConfigurationError);
    expect(mutationSpies.category).not.toHaveBeenCalled();
  });

  it('still calls through to the finance mutation implementation once a secret is configured', async () => {
    mutationSpies.assign.mockResolvedValue({ status: 'proposed' });
    const approvalSecret = 'invented-approval-secret-at-least-32-bytes';
    const tools = createFinanceMutationTools(approvalSecret);
    const execute = tools.assignFinanceTransactionKid.execute as unknown as ToolExecute;

    await execute(mutationInput, { toolCallId: 'call-3' });

    expect(mutationSpies.assign).toHaveBeenCalledWith(mutationInput, expect.objectContaining({
      approvalSecret,
      toolCallId: 'call-3',
    }));
  });

  it('callers must exclude finance mutations from activeTools when no secret is configured', () => {
    const tools = createHoustonTools(undefined);
    const activeTools = excludeFinanceMutations(Object.keys(tools) as Array<keyof typeof tools>);

    expect(activeTools).not.toContain('assignFinanceTransactionKid');
    expect(activeTools).not.toContain('updateFinanceTransactionCategory');
  });
});
