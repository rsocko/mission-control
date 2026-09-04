import 'server-only';

import type { FinanceAssistantPersistence } from '@/db/persistence/finance-assistant';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  assignFinanceTransactionKidInputSchema,
  updateFinanceTransactionCategoryInputSchema,
} from '@/lib/finance/houston-contracts';

const APPROVAL_TTL_MS = 60 * 60 * 1_000;

export const FINANCE_MUTATION_TOOL_NAMES = [
  'assignFinanceTransactionKid',
  'updateFinanceTransactionCategory',
] as const;

export type FinanceMutationToolName = typeof FINANCE_MUTATION_TOOL_NAMES[number];

type PendingApproval = {
  approvalId: string;
  toolCallId: string;
  toolName: FinanceMutationToolName;
  toolInput: unknown;
};

export class InvalidHoustonFinanceApprovalError extends Error {
  constructor(
    readonly approvalId: string,
    readonly toolName?: FinanceMutationToolName,
    readonly decision?: 'approve' | 'deny',
  ) {
    super('The finance approval is invalid, expired, or has already been used.');
    this.name = 'InvalidHoustonFinanceApprovalError';
  }
}

async function assistantPersistence(): Promise<FinanceAssistantPersistence> {
  return (await getWorkerPersistenceRepositories()).finance.assistant;
}

function parseToolInput(toolName: FinanceMutationToolName, input: unknown): unknown {
  return toolName === 'assignFinanceTransactionKid'
    ? assignFinanceTransactionKidInputSchema.parse(input)
    : updateFinanceTransactionCategoryInputSchema.parse(input);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Idempotently records one server-owned finance approval proposal. Persisting
 * the identical proposal again is a no-op; reusing an approval identity for
 * different arguments is rejected without disturbing the stored proposal.
 */
export async function persistHoustonFinanceApproval(
  approval: PendingApproval & { correlationId: string; now?: Date },
): Promise<void> {
  const now = approval.now ?? new Date();
  const toolInput = parseToolInput(approval.toolName, approval.toolInput);
  const persistence = await assistantPersistence();

  const result = await persistence.persistPendingApproval({
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    tool: approval.toolName,
    toolInput: canonicalJson(toolInput),
    correlationId: approval.correlationId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  });
  if (result.status === 'conflict') {
    throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
  }
}

/**
 * Consumes a matching, unexpired proposal exactly once. Expired, unknown,
 * mismatched, and already-consumed proposals all fail closed with the same
 * sanitized error so the client cannot distinguish them.
 */
export async function consumeHoustonFinanceApproval(
  approval: PendingApproval & { now?: Date },
): Promise<PendingApproval> {
  const now = approval.now ?? new Date();
  const submittedInput = parseToolInput(approval.toolName, approval.toolInput);
  const persistence = await assistantPersistence();

  const consumed = await persistence.consumePendingApproval({
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    tool: approval.toolName,
    toolInput: canonicalJson(submittedInput),
    now: now.toISOString(),
  });
  if (consumed.status !== 'consumed') {
    throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
  }

  return {
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    toolInput: JSON.parse(consumed.toolInput) as unknown,
  };
}
