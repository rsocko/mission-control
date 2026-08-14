import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateText,
  InvalidToolApprovalSignatureError,
  type ModelMessage,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

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

import { createFinanceMutationTools } from '@/lib/ai/tools/finance-tools';

const approvalSecret = 'invented-approval-secret-at-least-32-bytes';
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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function toolCallModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{
        type: 'tool-call',
        toolCallId: 'invented-call-id',
        toolName: 'assignFinanceTransactionKid',
        input: JSON.stringify(mutationInput),
      }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    },
  });
}

function finalModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'Finished.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
}

async function requestApproval() {
  const result = await generateText({
    model: toolCallModel(),
    messages: [{ role: 'user', content: 'Assign this transaction.' }],
    tools: createFinanceMutationTools(approvalSecret),
    experimental_toolApprovalSecret: approvalSecret,
  });
  const request = result.content.find(part => part.type === 'tool-approval-request');
  if (!request || request.type !== 'tool-approval-request') {
    throw new Error('Expected a tool approval request.');
  }
  return { result, request };
}

function approvalMessages(
  responseMessages: ModelMessage[],
  approvalId: string,
  approved: boolean,
): ModelMessage[] {
  return [
    { role: 'user', content: 'Assign this transaction.' },
    ...responseMessages,
    {
      role: 'tool',
      content: [{
        type: 'tool-approval-response',
        approvalId,
        approved,
        reason: approved ? 'User approved.' : 'User denied.',
      }],
    },
  ];
}

beforeEach(() => {
  mutationSpies.assign.mockReset().mockResolvedValue({
    kind: 'finance-kid-assignment',
    status: 'updated',
    missionControlConfirmed: { kidName: 'Avery' },
    replayed: false,
    provenance: [
      { kind: 'monarch-fact', label: 'Monarch facts via Tyrion Bridge', included: true },
      { kind: 'tyrion-derived', label: 'Tyrion-derived attribution/conclusions', included: true },
      { kind: 'mission-control-calculated', label: 'Mission Control-calculated aggregates', included: false },
      { kind: 'mission-control-confirmed', label: 'Mission Control-confirmed decision', included: true },
    ],
  });
  mutationSpies.category.mockReset();
});

describe('Houston signed finance approvals', () => {
  it('requests a signed approval without executing a mutation', async () => {
    const { request } = await requestApproval();
    expect(request.signature).toEqual(expect.any(String));
    expect(request.signature).not.toContain(approvalSecret);
    expect(mutationSpies.assign).not.toHaveBeenCalled();
  });

  it('executes exactly once after signed approval and never executes denial', async () => {
    const approved = await requestApproval();
    await generateText({
      model: finalModel(),
      messages: approvalMessages(
        approved.result.response.messages,
        approved.request.approvalId,
        true,
      ),
      tools: createFinanceMutationTools(approvalSecret),
      experimental_toolApprovalSecret: approvalSecret,
    });
    expect(mutationSpies.assign).toHaveBeenCalledTimes(1);

    mutationSpies.assign.mockClear();
    const denied = await requestApproval();
    await generateText({
      model: finalModel(),
      messages: approvalMessages(
        denied.result.response.messages,
        denied.request.approvalId,
        false,
      ),
      tools: createFinanceMutationTools(approvalSecret),
      experimental_toolApprovalSecret: approvalSecret,
    });
    expect(mutationSpies.assign).not.toHaveBeenCalled();
  });

  it('rejects changed arguments and tampered signatures before execution', async () => {
    const approved = await requestApproval();
    const tamperedArguments = structuredClone(approved.result.response.messages);
    for (const message of tamperedArguments) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const call = message.content.find(part => part.type === 'tool-call');
      if (call?.type === 'tool-call') {
        call.input = { ...mutationInput, kidName: 'Mallory' };
      }
    }
    await expect(generateText({
      model: finalModel(),
      messages: approvalMessages(
        tamperedArguments,
        approved.request.approvalId,
        true,
      ),
      tools: createFinanceMutationTools(approvalSecret),
      experimental_toolApprovalSecret: approvalSecret,
    })).rejects.toSatisfy(InvalidToolApprovalSignatureError.isInstance);
    expect(mutationSpies.assign).not.toHaveBeenCalled();

    const tamperedSignature = structuredClone(approved.result.response.messages);
    for (const message of tamperedSignature) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const request = message.content.find(part => part.type === 'tool-approval-request');
      if (request?.type === 'tool-approval-request') request.signature = 'tampered';
    }
    await expect(generateText({
      model: finalModel(),
      messages: approvalMessages(
        tamperedSignature,
        approved.request.approvalId,
        true,
      ),
      tools: createFinanceMutationTools(approvalSecret),
      experimental_toolApprovalSecret: approvalSecret,
    })).rejects.toSatisfy(InvalidToolApprovalSignatureError.isInstance);
    expect(mutationSpies.assign).not.toHaveBeenCalled();
  });
});
