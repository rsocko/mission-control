import { taskTools } from './task-tools';
import { notificationTools } from './notification-tools';
import { reasoningTools } from './reasoning-tools';
import { intakeTools } from './intake-tools';
import { triageTools } from './triage-tools';
import { financeTools } from './finance-tools';

export const aiTools = {
  ...taskTools,
  ...notificationTools,
  ...reasoningTools,
  ...intakeTools,
  ...triageTools,
  ...financeTools,
};
