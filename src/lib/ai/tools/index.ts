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
 * Builds the full Houston tool set. Finance mutation tools (which require
 * explicit AI SDK approval) are only included when an approval secret is
 * configured; every other tool — including finance read tools — must keep
 * working for non-finance requests even when the secret is missing.
 */
export function createHoustonTools(approvalSecret?: string) {
  if (!approvalSecret) return { ...aiTools };
  return {
    ...aiTools,
    ...createFinanceMutationTools(approvalSecret),
  };
}
