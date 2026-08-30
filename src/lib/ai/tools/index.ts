import { taskTools } from './task-tools';
import { notificationTools } from './notification-tools';
import { reasoningTools } from './reasoning-tools';
import { intakeTools } from './intake-tools';
import { triageTools } from './triage-tools';
import { createFinanceMutationTools, financeTools } from './finance-tools';
import { houstonMemoryTools } from './houston-memory-tools';

export const aiTools = {
  ...taskTools,
  ...notificationTools,
  ...reasoningTools,
  ...intakeTools,
  ...triageTools,
  ...financeTools,
  ...houstonMemoryTools,
};

/**
 * Builds the full Houston tool set.
 *
 * Finance mutation tools (which require explicit AI SDK approval) always
 * appear in this record with a fixed TypeScript shape so `toolsContext`
 * inference remains stable.
 */
export function createHoustonTools() {
  return {
    ...aiTools,
    ...createFinanceMutationTools(),
  };
}
