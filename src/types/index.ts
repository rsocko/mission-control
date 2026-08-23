import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';

// ─── CORE TYPES ─────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type MicroStatus =
  | 'waiting_on_someone'
  | 'need_to_think'
  | 'started_but_stuck'
  | 'ready_but_unmotivated'
  | 'done_needs_review'
  | 'blocked_external'
  | 'in_research'
  | 'on_hold';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type LocalDisposition = 'active' | 'handled' | 'dismissed';
export type EffortMeasure = 'tshirt' | 'simple' | 'label' | 'time';
export type TagType = 'source' | 'hub' | 'ai-inferred';
export type SyncStatus = 'synced' | 'pending_push' | 'conflict' | 'error';
export type TaskDependencySyncStatus = 'local' | 'pending' | 'synced' | 'failed';
export type TaskDependencySyncAction = 'create' | 'delete';

// ─── NOTIFICATION LEVELS ────────────────────────────────────────────────────

export type NotificationLevel = 'urgent' | 'action_needed' | 'heads_up' | 'fyi' | 'digest';
/** @deprecated Compatibility projection. Use the independent lifecycle fields instead. */
export type NotificationState = 'unread' | 'read' | 'dismissed' | 'resolved' | 'archived';
export type NotificationReadState = 'unread' | 'read';
export type NotificationDisposition = 'inbox' | 'handled' | 'dismissed';
export type NotificationSourceState = 'active' | 'resolved' | 'deleted' | 'unknown';
export type NotificationSyncState = 'synced' | 'pending' | 'failed';
export type NotificationReopenPolicy = 'handled' | 'handled_and_dismissed' | 'never';
export type NotificationActionType =
  | 'open_url'
  | 'create_task'
  | 'run_workflow'
  | 'navigate'
  | 'approve'
  | 'reject'
  | 'dismiss'
  | 'snooze'
  | 'remind_later'
  | 'complete_task'
  | 'dismiss_reminder';
export type NotificationActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type NotificationCategory =
  | 'system'
  | 'tasks'
  | 'development'
  | 'finance'
  | 'home'
  | 'social'
  | 'ai_insights'
  | 'packages'
  | 'infrastructure'
  | 'backup'
  | 'automation'
  | 'security';
export type SyncMode = 'webhook' | 'poll' | 'manual';
export type SourceListType = 'list' | 'project' | 'repo' | 'folder' | 'board';
export type TriageSourcePlatform =
  | 'reddit'
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'github'
  | 'twitter'
  | 'tiktok'
  | 'pinterest'
  | 'ios_share'
  | 'android_share'
  | 'browser_extension'
  | 'browser_tabs'
  | 'document-intelligence'
  | 'scout'
  | 'web';
export type TriageContentType = 'link' | 'image' | 'video' | 'text_post' | 'repo' | 'model_3d' | 'article' | 'product' | 'document';
export type TriageStatus = 'pending' | 'snoozed' | 'actioned' | 'dismissed';
export type TriageActionType =
  | 'save_karakeep'
  | 'save_knowledge_base'
  | 'create_task_github'
  | 'create_task_todo'
  | 'save_model_catalog'
  | 'trigger_workflow'
  | 'complete_action'
  | 'open_document'
  | 'defer_action'
  | 'dismiss'
  | 'snooze'
  | 'resurface';

// ─── TASKS & SUBTASKS ───────────────────────────────────────────────────────

export interface TaskItem {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;

  title: string;
  description?: string;
  status: TaskStatus;
  localDisposition?: LocalDisposition;
  microStatus?: MicroStatus;
  /** Reason a task was closed: 'completed' | 'not_planned' | 'duplicate' | 'moved' */
  statusReason?: 'completed' | 'not_planned' | 'duplicate' | 'moved';
  priority: TaskPriority;

  dueDate?: string;
  pushCount?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Source-backed or local snooze timestamp. Snoozed tasks remain open. */
  snoozedUntil?: string | null;

  // Hierarchy
  parentId?: string;
  childIds: string[];
  depth: number;
  isChecklistItem: boolean;

  // Source grouping
  sourceListId?: string;
  sourceListName?: string;

  // Hub organization
  hubProjectIds: string[];

  // Tags
  tags: Tag[];

  assignee?: string;

  metadata: Record<string, unknown>;
  /** Non-public connector evidence consumed after legacy source identity resolution. */
  externalIdentity?: ExternalIdentityEvidence;
  /** Non-public parent endpoint evidence used only for relationship identity comparison. */
  githubParentIdentity?: ExternalIdentityEvidence;
  syncStatus: SyncStatus;
  taskSourceModel?: TaskSourceModel;
  lastSyncedAt: string;

  // Effort (1–5, optional)
  effort?: number | null;

  // View state (local only)
  kanbanColumn?: string;
  kanbanOrder?: number;
}

export interface SourceTaskDependency {
  blockerSourceId: string;
  blockedSourceId: string;
  blockerIdentityEvidence?: ExternalIdentityEvidence;
  blockerIdentityEvidenceState?: SourceTaskDependencyIdentityEvidenceState;
}

export type SourceTaskDependencyIdentityEvidenceState = 'verified' | 'missing' | 'partial';

export interface SourceTaskDependencyBlockedIdentityEvidence {
  sourceId: string;
  evidence?: ExternalIdentityEvidence;
  state: SourceTaskDependencyIdentityEvidenceState;
}

export interface SourceTaskDependencySnapshot {
  dependencies: SourceTaskDependency[];
  completeBlockedSourceIds: string[];
  blockedIdentityEvidence?: SourceTaskDependencyBlockedIdentityEvidence[];
  overflowFetchCount?: number;
}

export type SourceTaskDependencyReadMode = 'graphql-bulk' | 'rest-fallback';

export interface SourceTaskDependencyGenerationWriter {
  /** Best-effort collectors must not turn relationship read failures into task sync failures. */
  readonly failureMode?: 'durable' | 'best-effort';
  stagePage(
    snapshot: SourceTaskDependencySnapshot,
    mode: SourceTaskDependencyReadMode,
  ): Promise<void>;
  complete(mode: SourceTaskDependencyReadMode): Promise<void>;
  fail(error: unknown): Promise<void>;
}

export interface FetchTaskOptions {
  signal?: AbortSignal;
  dependencyGeneration?: SourceTaskDependencyGenerationWriter;
}

// ─── TAGS ───────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  name: string;
  slug: string;
  type: TagType;
  source?: string;
  color?: string;
  confirmed: boolean;
  createdAt: string;
}

// ─── PROJECT & LIFECYCLE ─────────────────────────────────────────────────────

export type ProjectStatus = 'not_started' | 'active' | 'on_hold' | 'completed' | 'cancelled';
export type ProjectHealth = 'on_track' | 'at_risk' | 'behind';

export interface ProjectProgress {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  percentComplete: number;
  health: ProjectHealth;
  lastActivity?: string;
}

// ─── PROJECT PHASES ─────────────────────────────────────────────────────────

export type ProjectPhaseStatus = 'pending' | 'in_progress' | 'completed';

export interface ProjectPhase {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: ProjectPhaseStatus;
  color: string | null;
  estimatedDays: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  startAfterPhaseId: string | null;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPhaseItem {
  id: string;
  phaseId: string;
  taskId: string;
  sortOrder: number;
  estimatedEffortHours: number | null;
  isProposed: boolean;
  proposalType: string | null;
  createdAt: string;
}

// ─── HUB PROJECTS ───────────────────────────────────────────────────────────

export interface HubProject {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon?: string;
  iconColor?: string;

  sourceBindings: SourceBinding[];
  autoIncludeRules: AutoIncludeRule[];
  kanbanColumns: KanbanColumn[];

  defaultView: 'list' | 'kanban' | 'timeline';
  defaultFilters?: FilterPreset;

  // Lifecycle
  status: ProjectStatus;
  statusOverride?: ProjectStatus;
  hidden?: boolean;
  category?: string;
  targetDate?: string;
  startedAt?: string;
  completedAt?: string;
  sortOrder: number;
  metadata: Record<string, unknown>;

  // Relations
  tags: Tag[];

  // Computed (from API, not stored)
  progress?: ProjectProgress;

  createdAt: string;
  updatedAt: string;
}

// ─── PROJECT MILESTONES ─────────────────────────────────────────────────────

export interface ProjectMilestone {
  id: string;
  projectId: string;
  name: string;
  targetDate?: string;
  completedAt?: string;
  sortOrder: number;
  createdAt: string;
}

export interface SourceBinding {
  connectorInstanceId: string;
  /** Which list(s) to read/aggregate tasks from. Omit to read all lists. */
  sourceListId?: string;
  /** Where new tasks should be created when no explicit list is chosen.
   *  Separates "what to read" from "where to write". */
  defaultSourceListId?: string;
  filter?: string;
}

export interface AutoIncludeRule {
  type: 'tag' | 'title_contains' | 'source_list' | 'connector';
  value: string;
}

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  order: number;
  statusMapping?: TaskStatus[];
  wipLimit?: number;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: Record<string, unknown>;
}

// ─── SOURCE LISTS ───────────────────────────────────────────────────────────

export interface SourceList {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: SourceListType;
  taskCount: number;
  lastSyncedAt: string;
  /** Non-public connector evidence consumed after legacy source identity resolution. */
  externalIdentity?: ExternalIdentityEvidence;
  /** Identifies special/smart lists (e.g. 'flaggedEmails', 'defaultList') from Graph API */
  wellKnownListName?: string;
  /** Remote folder group ID from Substrate — used for auto-assigning list groups */
  parentFolderGroupId?: string;
}

// ─── INBOUND NOTIFICATIONS (raw connector data) ────────────────────────────

export interface InboundNotification {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;

  title: string;
  body?: string;
  level: NotificationLevel;
  category: string;
  /** Stable producer-defined notification type used for rendering and push policy. */
  templateKey?: string;

  isRead: boolean;
  isActionable: boolean;
  actionUrl?: string;

  receivedAt: string;
  expiresAt?: string;
  sourceState?: NotificationSourceState;
  sourceActivityAt?: string;
  sourceActivityKey?: string;
  reopenPolicy?: NotificationReopenPolicy;

  relatedTaskId?: string;
  hubProjectIds: string[];
  tags: Tag[];

  metadata: Record<string, unknown>;
}

/** @deprecated Use InboundNotification instead */
export type AlertItem = InboundNotification;

// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────

export interface NotificationAction {
  id: string;
  notificationId: string;
  actionType: NotificationActionType | string;
  label: string;
  icon?: string;
  variant: NotificationActionVariant;
  isPrimary: boolean;
  sortOrder: number;
  payload: Record<string, unknown>;
  opensExternal: boolean;
  requiresConfirmation: boolean;
  createdBy: 'system' | 'connector' | 'plugin' | 'ai';
}

export interface NotificationItem {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;

  title: string;
  body?: string | null;
  level: NotificationLevel;
  levelRank: number;
  category: NotificationCategory | string;
  templateKey?: string | null;

  state: NotificationState;
  readState: NotificationReadState;
  disposition: NotificationDisposition;
  sourceState: NotificationSourceState;
  syncState: NotificationSyncState;
  readAt?: string | null;
  handledAt?: string | null;
  dismissedAt?: string | null;
  resolvedAt?: string | null;
  archivedAt?: string | null;
  mutedAt?: string | null;
  snoozedUntil?: string | null;
  sourceResolvedAt?: string | null;
  lastSourceActivityAt?: string | null;
  lastSourceActivityKey?: string | null;
  handledSourceActivityAt?: string | null;
  handledSourceActivityKey?: string | null;
  lastSourceSyncedAt?: string | null;

  isActionable: boolean;
  primaryActionId?: string | null;
  aiSuggestedActionId?: string | null;

  receivedAt: string;
  sortAt: string;
  expiresAt?: string | null;
  groupKey?: string | null;
  dedupeKey?: string | null;

  relatedTaskId?: string | null;
  relatedProjectId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  navigationTarget?: string | null;

  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;

  // Hydrated on read
  actions?: NotificationAction[];
}

// ─── TRIAGE QUEUE ─────────────────────────────────────────────────────────────

export interface TriageSuggestedAction {
  actionType: TriageActionType;
  confidence: number;
  reason: string;
  label: string;
}

export interface TriageActionRecord {
  id?: string;
  actionType: TriageActionType;
  appliedAt: string;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface TriageItem {
  id: string;
  sourcePlatform: TriageSourcePlatform;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  contentType: TriageContentType;
  capturedAt: string;
  ingestedAt: string;
  status: TriageStatus;
  snoozedUntil?: string;
  aiSummary?: string;
  aiCategories: string[];
  aiSuggestedActions: TriageSuggestedAction[];
  aiRelevanceScore: number;
  aiUrgency: 'time_sensitive' | 'trending' | 'evergreen';
  rawMetadata: Record<string, unknown>;
  actionsTaken: TriageActionRecord[];
  sourceOrder?: number;
}

// ─── TASK SCHEDULE (Focus & Planning) ───────────────────────────────────────

export interface TaskSchedule {
  taskId: string;
  scheduledDate: string;
  scheduledTime?: string;
  estimatedDuration?: number; // minutes
  isTimeBlocked: boolean;
  recurrence?: string;
}

export type TaskSourceModel =
  | 'mc-owned'
  | 'remote-managed'
  | 'remote-mirror'
  | 'ingested';

export type WriteBackMode = 'none' | 'direct' | 'queued' | 'pull';

export type TaskField =
  | 'title'
  | 'description'
  | 'status'
  | 'statusReason'
  | 'priority'
  | 'dueDate'
  | 'effort'
  | 'estimatedDuration'
  | 'recurrence'
  | 'reminderAt'
  | 'snoozedUntil'
  | 'microStatus'
  | 'tags'
  | 'projects'
  | 'phases'
  | 'dependencies'
  | 'localDisposition'
  | 'kanbanPlacement';

export type TaskFieldMutationMode =
  | 'local'
  | 'write-through'
  | 'pull-write-back'
  | 'blocked';

export type TaskFieldInboundMode = 'source-wins' | 'local-wins' | 'merge';

export interface TaskFieldPolicy {
  field: TaskField;
  sourceModel: TaskSourceModel;
  mutation: TaskFieldMutationMode;
  inbound: TaskFieldInboundMode;
  reason?: string;
}

export interface TaskEditPolicy {
  sourceModel: TaskSourceModel;
  connectorEnabled: boolean;
  fields: Record<TaskField, TaskFieldPolicy>;
  editableFields: TaskField[];
  fieldReasons: Partial<Record<TaskField, string>>;
  localDeleteSupported: boolean;
  upstreamDeleteSupported: boolean;
  removalMode: 'local-delete' | 'local-cancel' | 'local-dismiss' | 'upstream-delete' | 'upstream-close' | 'blocked';
  removalReason?: string;
  sourceMoveSupported: boolean;
  sourceMoveReason?: string;
  localDispositionSupported: boolean;
}

export interface TaskFieldCapabilityProfile {
  authority: 'source' | 'local' | 'merge';
  writeBack?: WriteBackMode;
}

// ─── CONNECTOR CONFIG ───────────────────────────────────────────────────────

export interface ConnectorConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;

  syncMode: SyncMode;
  pollIntervalMinutes?: number;

  capabilities: ConnectorCapabilities;

  credentials: Record<string, string>;
  settings: Record<string, unknown>;

  syncedLists: string[];
}

export interface ConnectorCapabilities {
  read: boolean;
  write: boolean;
  delete: boolean;
  close?: boolean;         // Source supports closing/cancelling without hard deletion
  sync: boolean;
  subtasks: boolean;
  lists: boolean;
  tags: boolean;          // Source supports tags/labels/categories
  tagWriteBack: boolean;  // Can write tags back to source
  dueDate?: boolean;       // Source has a native due date field
  priority?: boolean;      // Source has a priority concept
  priorityWriteBack?: boolean; // Can write priority back to source
  microStatusSync?: boolean;      // Can represent micro-statuses as namespaced tags
  microStatusWriteBack?: boolean; // Can write micro-status back to source
  dependencyRead?: boolean;       // Can read native blocking dependencies
  dependencyWrite?: boolean;      // Can add and remove native blocking dependencies
  /**
   * Whether a specific list/repo must be chosen for task creation.
   * - 'required': User must pick a list (e.g. GitHub — no natural default repo)
   * - 'optional': Source has a sensible default (e.g. MS Todo defaultList)
   * - 'not-applicable': Source doesn't use lists for task creation
   */
  listSelectionMode?: 'required' | 'optional' | 'not-applicable';
  /**
   * How tags/labels are scoped within this connector.
   * - 'global': Tags apply across the entire source (e.g. MS Todo categories)
   * - 'per-list': Each list/repo has its own independent set of tags (e.g. GitHub labels)
   * Defaults to 'global' if not specified.
   */
  tagScope?: 'global' | 'per-list';
  /**
   * Whether the connector allows arbitrary tag creation or requires predefined tags.
   * - 'freeform': Any string can become a tag (e.g. MS Todo categories — type anything)
   * - 'predefined': Tags must already exist in the source before they can be applied
   *   (e.g. GitHub labels must be defined on the repo first)
   * Defaults to 'freeform' if not specified.
   */
  tagCreationMode?: 'freeform' | 'predefined';
  /**
   * Whether the connector supports deep links to individual tasks in the source.
   * When true, "Open in <Source>" actions are available in the UI.
   * Sources that don't support web deep links (e.g. Microsoft Todo) should leave
   * this false or omit it.
   */
  deepLinks?: boolean;
  /**
   * Whether the source connector automatically manages recurring task instances.
   * When true, the source creates the next occurrence upon completion — Mission Control
   * should NOT create one itself and should be cautious about auto-adding the next
   * occurrence to My Day.
   * Examples: Microsoft Todo (true), local tasks (false/undefined).
   */
  managedRecurrence?: boolean;
  /**
   * Whether the connector supports file attachments on tasks.
   * When true, users can upload/paste files and they will be synced to the source.
   * Microsoft Todo supports this via Graph API; GitHub does not expose attachment APIs.
   */
  attachments?: boolean;
  /**
   * Whether the connector supports creating new tasks (not just updating/completing).
   * When true, the connector can be a valid target for cross-source task moves/copies.
   * Connectors with write: true but taskCreate: false can update existing tasks but
   * cannot receive new ones.
   */
  taskCreate?: boolean;
  /** Whether existing tasks can be moved between lists within this source. */
  taskMove?: boolean;
  /**
   * Whether this connector only delivers notifications (not tasks).
   * When true, it won't appear as a source filter in the sidebar nav.
   * Examples: outlook-email, outlook-calendar, rymessage (true).
   * Connectors that ingest tasks (even push-only like Scout) should leave this false.
   */
  notificationOnly?: boolean;
  /** Authority model for durable tasks produced by this connector. */
  taskSourceModel?: TaskSourceModel;
  /** How status changes are exposed to the source. */
  statusWriteBack?: WriteBackMode;
  /** Mission Control lifecycle values the source can represent and write back. */
  supportedTaskStatuses?: TaskStatus[];
  /** Whether a task missing from a complete pull should be treated as deleted. */
  taskAbsenceMeansDeleted?: boolean;
  /** Whether a pull consumer remains active while its connector is disabled. */
  pullWriteBackWhenDisabled?: boolean;
  /** Optional per-field authority overrides for hybrid connectors. */
  taskFieldProfile?: Partial<Record<TaskField, TaskFieldCapabilityProfile>>;
}

// ─── SYNC RESULT ────────────────────────────────────────────────────────────

export interface SyncResult {
  connectorId: string;
  success: boolean;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  notificationsAdded: number;
  errors: string[];
  syncedAt: string;
  domainStatus?: 'fresh' | 'stale' | 'partial' | 'unavailable';
  datasetErrors?: DomainSyncResult['datasetErrors'];
}

export interface DomainSyncContext {
  full: boolean;
  signal?: AbortSignal;
  jobId?: string;
}

export interface DomainSyncResult {
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
  /** Notifications newly created while synchronizing connector-owned domain data. */
  notificationsAdded?: number;
  status?: 'fresh' | 'stale' | 'partial' | 'unavailable';
  datasetErrors?: Partial<Record<
    'transactions' | 'accounts' | 'category-groups' | 'categories' | 'tags' | 'recurring' | 'budgets',
    string
  >>;
}

// ─── MICRO-STATUS CONFIG ────────────────────────────────────────────────────

export const MICRO_STATUS_CONFIG: Record<MicroStatus, { label: string; emoji: string; color: string; description: string }> = {
  waiting_on_someone: { label: 'Waiting on someone', emoji: '⏳', color: '#f59e0b', description: 'Blocked waiting for a response or action from another person' },
  need_to_think: { label: 'Need to think', emoji: '🤔', color: '#8b5cf6', description: 'Requires reflection or planning before acting' },
  started_but_stuck: { label: 'Started but stuck', emoji: '🧱', color: '#ef4444', description: 'Work began but hit a wall — needs unblocking' },
  ready_but_unmotivated: { label: 'Ready but unmotivated', emoji: '😐', color: '#64748b', description: 'Could start anytime, just not feeling it' },
  done_needs_review: { label: 'Done, needs review', emoji: '👀', color: '#06b6d4', description: 'Work complete, awaiting review or confirmation' },
  blocked_external: { label: 'Blocked (external)', emoji: '🚧', color: '#dc2626', description: 'Blocked by external dependency or system' },
  in_research: { label: 'In research', emoji: '🔬', color: '#3b82f6', description: 'Actively researching or exploring approaches' },
  on_hold: { label: 'On hold', emoji: '⏸️', color: '#94a3b8', description: 'Intentionally paused — will resume later' },
};

// ─── TASK TEMPLATES ─────────────────────────────────────────────────────────

export type TemplateType = 'single' | 'workflow';
export type TemplateCategory = 'development' | 'home' | '3d-printing' | 'travel' | 'personal' | 'productivity' | 'general';

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  category?: TemplateCategory;
  type: TemplateType;
  icon?: string;
  subtasks: Array<{ title: string; priority?: string; estimatedMinutes?: number }>;
  workflowTasks?: Array<{
    title: string;
    description?: string;
    priority?: string;
    subtasks?: string[];
    tags?: string[];
  }>;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export const TEMPLATE_CATEGORY_CONFIG: Record<TemplateCategory, { label: string; emoji: string }> = {
  development: { label: 'Development', emoji: '💻' },
  home: { label: 'Home & Reno', emoji: '🏠' },
  '3d-printing': { label: '3D Printing', emoji: '🖨️' },
  travel: { label: 'Travel', emoji: '✈️' },
  personal: { label: 'Personal', emoji: '👤' },
  productivity: { label: 'Productivity', emoji: '📋' },
  general: { label: 'General', emoji: '📁' },
};
