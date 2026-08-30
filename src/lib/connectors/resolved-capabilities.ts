import type { ConnectorCapabilities } from '@/types';
import {
  DOCUMENT_INTELLIGENCE_TASK_AUTHORITY,
  GITHUB_ISSUES_TASK_AUTHORITY,
  MICROSOFT_TODO_TASK_AUTHORITY,
  SCOUT_TASK_AUTHORITY,
  WORK_TODO_TASK_AUTHORITY,
  resolveConnectorCapabilities,
} from './task-source-profiles';

/** Runtime capability defaults per connector type (for fields added after initial setup). */
export const CAPABILITY_DEFAULTS: Record<string, Partial<ConnectorCapabilities>> = {
  'microsoft-todo': {
    attachments: true,
    taskCreate: true,
    taskMove: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    tagScope: 'global',
    ...MICROSOFT_TODO_TASK_AUTHORITY,
  },
  'microsoft-todo-work': {
    taskCreate: false,
    taskMove: false,
    attachments: false,
    microStatusSync: false,
    microStatusWriteBack: false,
    tagScope: 'global',
    ...WORK_TODO_TASK_AUTHORITY,
  },
  'github-issues': {
    close: true,
    taskCreate: true,
    taskMove: false,
    dependencyRead: true,
    dependencyWrite: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    tagScope: 'per-list',
    ...GITHUB_ISSUES_TASK_AUTHORITY,
  },
  'document-intelligence': {
    ...DOCUMENT_INTELLIGENCE_TASK_AUTHORITY,
  },
  scout: {
    ...SCOUT_TASK_AUTHORITY,
  },
};

export function resolvePersistedConnectorCapabilities(input: {
  type: string;
  capabilities: ConnectorCapabilities;
  settings: Record<string, unknown>;
}): ConnectorCapabilities {
  return resolveConnectorCapabilities(
    input.type,
    {
      ...(CAPABILITY_DEFAULTS[input.type] ?? {}),
      ...input.capabilities,
    } as ConnectorCapabilities,
    input.settings,
  );
}
