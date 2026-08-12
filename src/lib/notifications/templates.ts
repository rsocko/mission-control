/**
 * Notification Templates — define display defaults and expected metadata
 * for known notification types. Connectors and plugins can register additional
 * templates at runtime via the plugin registry.
 */

import type { NotificationLevel, NotificationActionType } from '@/types';

export interface NotificationTemplate {
  key: string;
  category: string;
  defaultLevel: NotificationLevel;
  titleTemplate?: string;
  bodyTemplate?: string;
  categoryIcon: string;
  sourceDisplayMode: 'compact' | 'prominent';
  defaultActions: DefaultAction[];
}

export interface DefaultAction {
  actionType: NotificationActionType | string;
  label: string;
  icon: string;
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  isPrimary?: boolean;
  opensExternal?: boolean;
  payloadTemplate?: Record<string, string>;
}

// ─── TEMPLATE REGISTRY ──────────────────────────────────────────────────────

const templates = new Map<string, NotificationTemplate>();

export function registerTemplate(template: NotificationTemplate): void {
  templates.set(template.key, template.category.trim().toLowerCase() === 'finance'
    ? {
        ...template,
        defaultActions: template.defaultActions.filter(action => action.actionType !== 'create_task'),
      }
    : template);
}

export function getTemplate(key: string): NotificationTemplate | undefined {
  return templates.get(key);
}

export function getAllTemplates(): NotificationTemplate[] {
  return Array.from(templates.values());
}

// ─── BUILT-IN TEMPLATES ─────────────────────────────────────────────────────

// Finance
registerTemplate({
  key: 'budget_exceeded',
  category: 'finance',
  defaultLevel: 'action_needed',
  categoryIcon: 'dollar-sign',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'View Budget', icon: 'bar-chart-3', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/finance' } },
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost' },
  ],
});

registerTemplate({
  key: 'kid_threshold',
  category: 'finance',
  defaultLevel: 'action_needed',
  categoryIcon: 'dollar-sign',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'View Transactions', icon: 'list', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/finance' } },
  ],
});

registerTemplate({
  key: 'anomaly',
  category: 'finance',
  defaultLevel: 'heads_up',
  categoryIcon: 'alert-triangle',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Review', icon: 'search', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/finance' } },
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost' },
  ],
});

registerTemplate({
  key: 'subscription_duplicate',
  category: 'finance',
  defaultLevel: 'fyi',
  categoryIcon: 'repeat',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Review Subscriptions', icon: 'list', variant: 'primary', isPrimary: true },
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost' },
  ],
});

registerTemplate({
  key: 'bill_upcoming',
  category: 'finance',
  defaultLevel: 'fyi',
  categoryIcon: 'calendar',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'View Bill', icon: 'file-text', variant: 'secondary', isPrimary: true },
  ],
});

registerTemplate({
  key: 'weekly_summary',
  category: 'ai_insights',
  defaultLevel: 'digest',
  categoryIcon: 'newspaper',
  sourceDisplayMode: 'prominent',
  defaultActions: [
    { actionType: 'navigate', label: 'View Summary', icon: 'bar-chart-3', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/insights' } },
  ],
});

// System
registerTemplate({
  key: 'connector_auth_expired',
  category: 'system',
  defaultLevel: 'urgent',
  categoryIcon: 'plug-zap',
  sourceDisplayMode: 'prominent',
  defaultActions: [
    { actionType: 'navigate', label: 'Reconnect', icon: 'refresh-cw', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/settings' } },
  ],
});

registerTemplate({
  key: 'sync_failed',
  category: 'system',
  defaultLevel: 'action_needed',
  categoryIcon: 'server',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'View Log', icon: 'file-text', variant: 'secondary', isPrimary: true, payloadTemplate: { target: '/settings' } },
    { actionType: 'run_workflow', label: 'Retry Sync', icon: 'refresh-cw', variant: 'primary' },
  ],
});

registerTemplate({
  key: 'sync_completed',
  category: 'system',
  defaultLevel: 'digest',
  categoryIcon: 'check-circle',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost', isPrimary: true },
  ],
});

// Social / Code
registerTemplate({
  key: 'pr_review_requested',
  category: 'social',
  defaultLevel: 'action_needed',
  categoryIcon: 'git-pull-request',
  sourceDisplayMode: 'prominent',
  defaultActions: [
    { actionType: 'open_url', label: 'Review PR', icon: 'external-link', variant: 'primary', isPrimary: true, opensExternal: true },
    { actionType: 'create_task', label: 'Schedule Review', icon: 'clock', variant: 'secondary' },
  ],
});

registerTemplate({
  key: 'mention',
  category: 'social',
  defaultLevel: 'heads_up',
  categoryIcon: 'at-sign',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'open_url', label: 'View', icon: 'external-link', variant: 'primary', isPrimary: true, opensExternal: true },
  ],
});

// Home
registerTemplate({
  key: 'device_state_change',
  category: 'home',
  defaultLevel: 'urgent',
  categoryIcon: 'home',
  sourceDisplayMode: 'prominent',
  defaultActions: [
    { actionType: 'run_workflow', label: 'Take Action', icon: 'zap', variant: 'primary', isPrimary: true },
    { actionType: 'dismiss', label: 'Acknowledge', icon: 'check', variant: 'secondary' },
  ],
});

// Packages
registerTemplate({
  key: 'delivery_update',
  category: 'packages',
  defaultLevel: 'heads_up',
  categoryIcon: 'truck',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'open_url', label: 'Track Package', icon: 'external-link', variant: 'primary', isPrimary: true, opensExternal: true },
  ],
});

registerTemplate({
  key: 'delivery_arriving_today',
  category: 'packages',
  defaultLevel: 'fyi',
  categoryIcon: 'package',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'open_url', label: 'Track', icon: 'external-link', variant: 'secondary', isPrimary: true, opensExternal: true },
  ],
});

// Tasks
registerTemplate({
  key: 'task_overdue',
  category: 'tasks',
  defaultLevel: 'action_needed',
  categoryIcon: 'alert-circle',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Open Task', icon: 'check-square', variant: 'primary', isPrimary: true },
    { actionType: 'snooze', label: 'Snooze', icon: 'clock', variant: 'ghost' },
  ],
});

registerTemplate({
  key: 'task_due_today',
  category: 'tasks',
  defaultLevel: 'heads_up',
  categoryIcon: 'calendar',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Open Task', icon: 'check-square', variant: 'primary', isPrimary: true },
  ],
});

// Push trigger templates
registerTemplate({
  key: 'morning_start_day',
  category: 'tasks',
  defaultLevel: 'fyi',
  categoryIcon: 'sunrise',
  sourceDisplayMode: 'prominent',
  defaultActions: [
    { actionType: 'navigate', label: 'View Today', icon: 'calendar', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/today' } },
  ],
});

registerTemplate({
  key: 'triage_nudge',
  category: 'tasks',
  defaultLevel: 'heads_up',
  categoryIcon: 'inbox',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Open Triage', icon: 'inbox', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/triage' } },
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost' },
  ],
});

registerTemplate({
  key: 'carry_forward',
  category: 'tasks',
  defaultLevel: 'heads_up',
  categoryIcon: 'moon',
  sourceDisplayMode: 'compact',
  defaultActions: [
    { actionType: 'navigate', label: 'Review Tasks', icon: 'check-square', variant: 'primary', isPrimary: true, payloadTemplate: { target: '/today' } },
    { actionType: 'dismiss', label: 'Dismiss', icon: 'x', variant: 'ghost' },
  ],
});
