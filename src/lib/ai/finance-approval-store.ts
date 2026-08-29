import 'server-only';

import { sqlite } from '@/db';
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

export function persistHoustonFinanceApproval(
  approval: PendingApproval & { correlationId: string; now?: Date },
): void {
  const now = approval.now ?? new Date();
  const toolInput = parseToolInput(approval.toolName, approval.toolInput);
  const storedInput = canonicalJson(toolInput);
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();

  sqlite.transaction(() => {
    sqlite.prepare(`
      DELETE FROM houston_finance_pending_approvals
      WHERE expires_at <= ?
    `).run(now.toISOString());

    const existing = sqlite.prepare(`
      SELECT tool_call_id AS toolCallId, tool, tool_input AS toolInput
      FROM houston_finance_pending_approvals
      WHERE approval_id = ?
    `).get(approval.approvalId) as {
      toolCallId: string;
      tool: FinanceMutationToolName;
      toolInput: string;
    } | undefined;

    if (existing) {
      if (
        existing.toolCallId !== approval.toolCallId
        || existing.tool !== approval.toolName
        || existing.toolInput !== storedInput
      ) {
        throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
      }
      return;
    }

    sqlite.prepare(`
      INSERT INTO houston_finance_pending_approvals (
        approval_id, tool_call_id, tool, tool_input, correlation_id,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.approvalId,
      approval.toolCallId,
      approval.toolName,
      storedInput,
      approval.correlationId,
      expiresAt,
      now.toISOString(),
    );
  })();
}

export function consumeHoustonFinanceApproval(
  approval: PendingApproval & { now?: Date },
): PendingApproval {
  const now = approval.now ?? new Date();
  const consumed = sqlite.transaction((): PendingApproval | null => {
    const stored = sqlite.prepare(`
      SELECT approval_id AS approvalId, tool_call_id AS toolCallId,
             tool AS toolName, tool_input AS toolInput, expires_at AS expiresAt
      FROM houston_finance_pending_approvals
      WHERE approval_id = ?
    `).get(approval.approvalId) as {
      approvalId: string;
      toolCallId: string;
      toolName: FinanceMutationToolName;
      toolInput: string;
      expiresAt: string;
    } | undefined;

    const submittedInput = parseToolInput(approval.toolName, approval.toolInput);
    if (stored && stored.expiresAt <= now.toISOString()) {
      sqlite.prepare(`
        DELETE FROM houston_finance_pending_approvals
        WHERE approval_id = ?
      `).run(approval.approvalId);
      return null;
    }
    if (
      !stored
      || stored.toolCallId !== approval.toolCallId
      || stored.toolName !== approval.toolName
      || stored.toolInput !== canonicalJson(submittedInput)
    ) {
      throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
    }

    const deleted = sqlite.prepare(`
      DELETE FROM houston_finance_pending_approvals
      WHERE approval_id = ?
    `).run(approval.approvalId);
    if (deleted.changes !== 1) {
      throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
    }

    return {
      approvalId: stored.approvalId,
      toolCallId: stored.toolCallId,
      toolName: stored.toolName,
      toolInput: JSON.parse(stored.toolInput) as unknown,
    };
  })();
  if (!consumed) {
    throw new InvalidHoustonFinanceApprovalError(approval.approvalId, approval.toolName);
  }
  return consumed;
}
