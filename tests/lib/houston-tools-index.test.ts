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
  it('always includes both finance mutation tool keys', () => {
    const tools = createHoustonTools();

    expect(tools).toHaveProperty('assignFinanceTransactionKid');
    expect(tools).toHaveProperty('updateFinanceTransactionCategory');
  });

  it('fails closed when a finance mutation executes without server approval context', () => {
    const tools = createFinanceMutationTools();
    const execute = tools.assignFinanceTransactionKid.execute as unknown as ToolExecute;

    expect(() => execute(mutationInput, { toolCallId: 'call-1' }))
      .toThrow('The finance approval context is unavailable.');
    expect(mutationSpies.assign).not.toHaveBeenCalled();

    const executeCategory = tools.updateFinanceTransactionCategory.execute as unknown as ToolExecute;
    expect(() => executeCategory(mutationInput, { toolCallId: 'call-2' }))
      .toThrow('The finance approval context is unavailable.');
    expect(mutationSpies.category).not.toHaveBeenCalled();
  });

  it('calls through with the consumed server approval ID', async () => {
    mutationSpies.assign.mockResolvedValue({ status: 'proposed' });
    const tools = createFinanceMutationTools();
    const execute = tools.assignFinanceTransactionKid.execute as unknown as ToolExecute;

    await execute(mutationInput, {
      toolCallId: 'call-3',
      context: {
        correlationId: 'invented-correlation',
        financeApprovalIds: { 'call-3': 'invented-approval-id' },
      },
    });

    expect(mutationSpies.assign).toHaveBeenCalledWith(mutationInput, expect.objectContaining({
      approvalId: 'invented-approval-id',
      correlationId: 'invented-correlation',
    }));
  });

  it('callers without approval persistence can exclude finance mutations', () => {
    const tools = createHoustonTools();
    const activeTools = excludeFinanceMutations(Object.keys(tools) as Array<keyof typeof tools>);

    expect(activeTools).not.toContain('assignFinanceTransactionKid');
    expect(activeTools).not.toContain('updateFinanceTransactionCategory');
  });
});
