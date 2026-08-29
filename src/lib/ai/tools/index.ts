import { taskTools } from './task-tools';
import { notificationTools } from './notification-tools';
import { reasoningTools } from './reasoning-tools';
import { intakeTools } from './intake-tools';
import { triageTools } from './triage-tools';
import { createFinanceMutationTools, financeTools } from './finance-tools';

export const aiTools = {
  ...taskTools,
  ...notificationTools,
  ...reasoningTools,
  ...intakeTools,
  ...triageTools,
  ...financeTools,
};

/**
 * Builds the full Houston tool set.
 *
 * Finance mutation tools (which require explicit AI SDK approval) always
 * appear in this record with a fixed, single (non-union) TypeScript shape —
 * required for `toolsContext` inference (`InferToolSetContext`) to resolve
 * the finance tool context keys instead of collapsing to `{}` when the
 * return type would otherwise vary by branch. When no approval secret is
 * configured, those tools' `execute` fails closed (see
 * `createFinanceMutationTools`) and callers MUST also keep them out of
 * `activeTools` so the model is never offered them — see `chat.ts`'s
 * `excludeFinanceMutations` usage. Every other tool, including finance read
 * tools, keeps working for non-finance requests even when the secret is
 * missing.
 */
export function createHoustonTools(approvalSecret?: string) {
  return {
    ...aiTools,
    ...createFinanceMutationTools(approvalSecret),
  };
}
