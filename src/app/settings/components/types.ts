// Shared types and constants for settings components
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';

export { getConnectorDisplayName } from '@/lib/connectors/display-name';

export interface ConnectorConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  syncMode: string;
  pollIntervalMinutes: number | null;
  capabilities: Record<string, boolean>;
  credentials: Record<string, string>;
  hasCredentials?: boolean;
  settings: Record<string, unknown>;
  syncedLists: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SourceList {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  taskCount: number;
  lastSyncedAt: string | null;
  wellKnownListName?: string | null;
  groupId: string | null;
  sortOrder?: number;
  hidden?: boolean;
  icon?: string | null;
  iconColor?: string | null;
}

export interface ListGroup {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
  sortOrder: number;
  createdAt: string;
  sourceLists?: SourceList[];
}

export interface SyncLogEntry {
  id: string;
  connectorId: string;
  success: boolean;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  tasksPushed: number;
  localOnlyProtected: number;
  notificationsAdded: number;
  errors: string[] | string;
  details: SyncAuditDetail[] | string;
  syncedAt: string;
  durationMs: number | null;
  jobId?: string | null;
  trigger?: 'api' | 'schedule' | 'nightly' | 'watchdog' | 'recovery' | null;
  scheduledFor?: string | null;
  startedAt?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
}

export interface SyncScheduleHealth {
  status: 'healthy' | 'action_required';
  message: string;
  userAction: {
    type: 'sync_now' | 'restart_worker';
    label: string;
    detail: string;
  } | null;
  worker: {
    available: boolean;
    startedAt: string;
    heartbeatAt: string;
  } | null;
  schedules: Array<{
    connectorId: string;
    intervalMinutes: number;
    nextDueAt: string;
    lastEnqueuedAt: string | null;
    overdueMs: number;
    overdue: boolean;
  }>;
}

export interface SyncAuditDetail {
  action: 'added' | 'updated' | 'removed' | 'pushed' | 'push_failed' | 'protected' | 'conflict_resolved';
  taskTitle: string;
  taskSourceId: string;
  taskId?: string;
  deletionSnapshotId?: string;
  reason?: string;
  listName?: string;
  resolution?: import('@/lib/sync/retention').RetentionResolutionRecord;
}

export interface N8NConfigState {
  baseUrl: string;
  enabled: boolean;
  workflowCount: number;
  connected: boolean;
  lastCheckedAt: string | null;
}

export interface OutboundWebhookSubscription {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: string[];
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: number | null;
  createdAt: string;
}

export interface InboundWebhookConfig {
  id: string;
  name: string;
  sourceLabel: string;
  secret: string | null;
  enabled: boolean;
  defaultAction: 'task' | 'alert' | 'auto';
  fieldMappings: Record<string, string>;
  totalReceived: number;
  lastReceivedAt: string | null;
  lastStatus: number | null;
  createdAt: string;
  updatedAt: string;
}

export const INTEGRATION_EVENT_OPTIONS = [
  'task.created',
  'task.completed',
  'task.overdue',
  'alert.received',
  'alert.dismissed',
  'sync.completed',
  'finance.notification',
  'project.status_changed',
] as const;

export const CONNECTOR_TYPES = [
  { type: 'microsoft-todo', name: 'Microsoft Todo', description: 'Tasks, lists, and categories via Graph API' },
  { type: 'microsoft-todo-work', name: 'Microsoft To Do - Work', description: 'Corporate To Do through Power Automate and Scout' },
  { type: 'github-issues', name: 'GitHub Issues', description: 'Issues, labels, sub-issues, and projects' },
  { type: 'outlook-calendar', name: 'Outlook Calendar', description: 'Calendar events and meeting alerts' },
  { type: 'outlook-email', name: 'Outlook Email', description: 'Flagged emails and action-required messages' },
  { type: 'scout', name: 'Scout', description: 'AI-curated action items from M365 (push-only via MCP)' },
  { type: 'rymessage', name: 'RyMessage', description: 'AI-extracted actions from iMessage via RyMessage desktop client' },
  { type: 'finance-manager', name: 'Tyrion', description: 'Monarch Money bridge for Mission Control' },
  { type: 'custom-rest', name: 'Custom REST API', description: 'Connect any REST endpoint with flexible mapping' },
  { type: 'document-intelligence', name: 'OWL', description: 'Paperless-ngx connector and document agent for Mission Control' },
  { type: 'home-assistant', name: 'Home Assistant', description: 'Smart home alerts, package tracking, device monitoring' },
];

// Brand icons for each connector type
export const CONNECTOR_ICONS: Record<string, string> = {
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'microsoft-todo-work': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'scout': 'dash:microsoft-copilot',
  finance: '/icons/connectors/tyrion.svg',
  'finance-manager': '/icons/connectors/tyrion.svg',
  'monarch-money': '/icons/connectors/tyrion.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
  'document-intelligence': '/icons/agents/owl.svg',
};


export const FINANCE_CONNECTOR_TYPES = new Set<string>(FINANCE_PROVIDER_ALIASES);

export function isFinanceConnectorType(type: string) {
  return FINANCE_CONNECTOR_TYPES.has(type);
}

export function normalizeSyncedLists(syncedLists: unknown): string[] {
  if (Array.isArray(syncedLists)) {
    return syncedLists.filter((value): value is string => typeof value === 'string');
  }

  if (typeof syncedLists === 'string') {
    try {
      const parsed = JSON.parse(syncedLists);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

export function isSourceListSelected(connector: ConnectorConfig, sourceList: SourceList): boolean {
  const syncedLists = connector.type === 'github-issues'
    ? normalizeSyncedLists(connector.settings.repos)
    : normalizeSyncedLists(connector.syncedLists);
  return (connector.type !== 'github-issues' && syncedLists.length === 0)
    || syncedLists.includes(sourceList.sourceId)
    || syncedLists.includes(sourceList.id);
}
