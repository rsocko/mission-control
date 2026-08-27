import type { TaskFilterContext } from '@/lib/task-filter-context';
import type {
  HubProjectSummaryDto,
  TaskListItemDto,
  TaskListResponseDto,
  TaskListStatsDto,
  TaskTagDto,
} from '@/types/api';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { PRIORITY_BADGE_COLORS, PRIORITY_LABELS as TASK_PRIORITY_LABELS, TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';

export type DashboardTaskTagViewModel = TaskTagDto;
export type DashboardTaskViewModel = TaskListItemDto;
export type DashboardTaskStatsViewModel = TaskListStatsDto;
export type DashboardTaskResponseViewModel = TaskListResponseDto;
export type DashboardProjectViewModel = HubProjectSummaryDto;

export interface ListGroup {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
  hidden?: boolean;
  sortOrder?: number;
  icon?: string | null;
  iconColor?: string | null;
  selectedForSync?: boolean;
}

export interface EnabledSource {
  type: string;
  name: string;
  icon: string;
  notificationOnly?: boolean;
  tagScope?: 'global' | 'per-list';
  tagCreationMode?: 'freeform' | 'predefined';
}

export interface SyncStatusEntry {
  id: string;
  type: string;
  name: string;
  lastSyncedAt: string | null;
  enabled: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  icon: string;
  iconColor?: string;
  filters: Record<string, string>;
  filterContext?: TaskFilterContext;
}

export interface ConnectorCaps {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export const PAGE_SIZE = 50;

export const EMPTY_TASK_RESPONSE: DashboardTaskResponseViewModel = {
  tasks: [],
  total: 0,
  stats: {
    totalOpen: 0,
    overdue: 0,
    dueToday: 0,
    dueThisWeek: 0,
    noDate: 0,
    highPriority: 0,
    assignedToMe: 0,
    myDay: 0,
    recentlyCreated: 0,
    recentlyClosed: 0,
    waiting: 0,
    inbox: 0,
  },
  hasMore: false,
  sourceCounts: {},
  availableTags: [],
};

export const CONNECTOR_ICONS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'microsoft-todo-work': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  finance: '/icons/connectors/tyrion.svg',
  'finance-manager': '/icons/connectors/tyrion.svg',
  'monarch-money': '/icons/connectors/tyrion.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
  'scout': 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-copilot.svg',
};

export const PRIORITY_COLORS = PRIORITY_BADGE_COLORS;

export const PRIORITY_LABELS = TASK_PRIORITY_LABELS;

export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(TASK_STATUS_VISUALS).map(([status, visual]) => [status, visual.badgeClass]),
);

export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(TASK_STATUS_VISUALS).map(([status, visual]) => [status, visual.label]),
);

// ─── NOTIFICATION LEVEL DESIGN TOKENS ───────────────────────────────────────

export interface NotificationLevelConfig {
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  borderColor: string;
  pillClass: string;
  buttonClass: string;
}

export const NOTIFICATION_LEVELS: Record<string, NotificationLevelConfig> = {
  urgent: {
    label: 'Urgent',
    icon: 'alert-circle',
    color: 'text-red-400',
    bgColor: 'bg-transparent',
    borderColor: 'border-red-500/70',
    pillClass: 'bg-red-900/40 text-red-300 border border-red-800/40',
    buttonClass: 'bg-red-600 hover:bg-red-500 text-white shadow-sm shadow-red-900/40',
  },
  action_needed: {
    label: 'Action Needed',
    icon: 'alert-triangle',
    color: 'text-amber-400',
    bgColor: 'bg-transparent',
    borderColor: 'border-amber-500/60',
    pillClass: 'bg-amber-900/30 text-amber-300 border border-amber-800/40',
    buttonClass: 'bg-amber-600 hover:bg-amber-500 text-white shadow-sm shadow-amber-900/40',
  },
  heads_up: {
    label: 'Heads Up',
    icon: 'info',
    color: 'text-blue-400',
    bgColor: 'bg-transparent',
    borderColor: 'border-blue-500/40',
    pillClass: 'bg-blue-900/30 text-blue-300 border border-blue-800/40',
    buttonClass: 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-900/40',
  },
  fyi: {
    label: 'FYI',
    icon: 'message-circle',
    color: 'text-slate-400',
    bgColor: 'bg-transparent',
    borderColor: 'border-slate-600/40',
    pillClass: 'bg-slate-800/30 text-slate-300 border border-slate-700/40',
    buttonClass: 'bg-slate-600 hover:bg-slate-500 text-white shadow-sm shadow-slate-900/40',
  },
  digest: {
    label: 'Digest',
    icon: 'newspaper',
    color: 'text-purple-400',
    bgColor: 'bg-transparent',
    borderColor: 'border-purple-500/40',
    pillClass: 'bg-purple-900/25 text-purple-300 border border-purple-800/40',
    buttonClass: 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm shadow-purple-900/40',
  },
};

export const NOTIFICATION_CATEGORY_ICONS: Record<string, string> = {
  system: 'server',
  tasks: 'check-square',
  development: 'git-pull-request',
  finance: 'dollar-sign',
  home: 'home',
  social: 'at-sign',
  ai_insights: 'sparkles',
  packages: 'package',
  infrastructure: 'server',
  backup: 'archive',
  automation: 'workflow',
  security: 'shield-alert',
};

export const NOTIFICATION_SOURCE_ICONS: Record<string, string> = {
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'microsoft-todo-work': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  finance: '/icons/agents/tyrion.svg',
  'finance-manager': '/icons/agents/tyrion.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
  'home-assistant': '/icons/connectors/custom-rest.svg',
  'monarch-money': '/icons/agents/tyrion.svg',
  homelab: '/icons/connectors/custom-rest.svg',
};

export const NOTIFICATION_SOURCE_LABELS: Record<string, string> = {
  'microsoft-todo': 'Microsoft To Do',
  'microsoft-todo-work': 'Microsoft To Do - Work',
  'github-issues': 'GitHub',
  'outlook-email': 'Outlook Mail',
  'outlook-calendar': 'Outlook Calendar',
  rymessage: 'RyMessage',
  'document-intelligence': 'OWL',
  finance: 'Tyrion',
  'finance-manager': 'Tyrion',
  'custom-rest': 'Custom REST',
  scout: 'Scout',
  'home-assistant': 'Home Assistant',
  'monarch-money': 'Tyrion',
  homelab: 'Homelab',
};
