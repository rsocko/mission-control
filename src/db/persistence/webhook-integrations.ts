/**
 * Layer L20: the webhook configuration / delivery / log persistence contract.
 *
 * One cohesive port for every webhook surface the web tier owns: inbound
 * webhook configuration and their delivery/replay/log tables, outbound webhook
 * subscriptions, the n8n integration configuration, and the shared
 * task/notification ingestion the n8n, RyMessage, and per-connector webhook
 * receivers perform.
 *
 * The module is intentionally driver-free (no `@/db`, no `better-sqlite3`, no
 * `pg`, no `drizzle-orm`): the adapters own all SQL and all multi-row
 * transactions, and the routes only ever see the neutral records below.
 *
 * Secret handling is explicit rather than incidental. Reads that feed a UI
 * listing return the *redacted* representation (`InboundWebhookSummary`
 * carries `hasSecret`, never the secret itself); reads that exist to perform
 * signature verification or signed delivery return the secret because that is
 * their entire purpose (`InboundWebhookDeliveryConfig`,
 * `OutboundWebhookRecord`). No adapter may log or embed a secret in an error.
 */

/**
 * Replay-suppression window: a claim is held for five minutes from the
 * delivery's `receivedAt`. The receiver owns that clock and passes the
 * resulting `expiresAt` on {@link ClaimInboundWebhookDeliveryInput}; after it
 * lapses the same payload may legitimately be delivered again.
 */

// ─── Inbound webhook configuration ──────────────────────────────────────────

/** Redacted inbound webhook projection used by the configuration UI. */
export interface InboundWebhookSummary {
  id: string;
  name: string;
  sourceLabel: string;
  enabled: boolean;
  defaultAction: string;
  fieldMappings: Record<string, unknown>;
  totalReceived: number;
  lastReceivedAt: string | null;
  lastStatus: number | null;
  createdAt: string;
  updatedAt: string;
  /** Whether a verification secret is configured. The secret is never returned. */
  hasSecret: boolean;
}

/**
 * The receive-path projection. `secret` is the intended representation here
 * (and only here) because HMAC verification cannot happen without it.
 */
export interface InboundWebhookDeliveryConfig {
  id: string;
  name: string;
  sourceLabel: string;
  secret: string | null;
  enabled: boolean;
  defaultAction: string;
  fieldMappings: Record<string, unknown>;
}

export interface CreateInboundWebhookInput {
  id: string;
  name: string;
  sourceLabel: string;
  secret: string | null;
  defaultAction: string;
  fieldMappings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A sparse inbound webhook patch. An absent key is left unchanged; `secret:
 * null` explicitly clears the stored verification secret.
 */
export interface InboundWebhookPatch {
  name?: string;
  sourceLabel?: string;
  secret?: string | null;
  enabled?: boolean;
  defaultAction?: string;
  fieldMappings?: Record<string, unknown>;
}

export interface UpdateInboundWebhookInput {
  id: string;
  patch: InboundWebhookPatch;
  updatedAt: string;
}

/**
 * `secret-referenced` means the patch would have cleared a secret an enabled,
 * non-deleted external agent still depends on, so nothing was written.
 */
export type UpdateInboundWebhookOutcome = 'updated' | 'secret-referenced';

/**
 * `agent-referenced` means an enabled, non-deleted external agent still points
 * at the webhook, so neither it nor its push rules were deleted.
 */
export type DeleteInboundWebhookOutcome = 'deleted' | 'agent-referenced';

// ─── Inbound webhook delivery log ───────────────────────────────────────────

export interface InboundWebhookLogEntry {
  id: string;
  webhookId: string;
  status: string;
  httpStatus: number;
  createdType: string | null;
  createdId: string | null;
  errorMessage: string | null;
  payloadPreview: string | null;
  receivedAt: string;
}

/**
 * Bounded retention applied after a log append. Rows older than
 * `retentionCutoff` are dropped, then everything past the newest
 * `retainLatest` entries in the deterministic
 * `received_at DESC, id DESC` order is dropped as well.
 */
export interface InboundWebhookLogCompaction {
  retentionCutoff: string;
  retainLatest: number;
}

export interface AppendInboundWebhookLogInput {
  entry: InboundWebhookLogEntry;
  /** `null` skips compaction for this append. */
  compaction: InboundWebhookLogCompaction | null;
}

export interface ListInboundWebhookLogInput {
  webhookId: string;
  limit: number;
}

// ─── Inbound webhook delivery claims ────────────────────────────────────────

export interface ClaimInboundWebhookDeliveryInput {
  /** Identity of the replay row to insert when the claim is won. */
  id: string;
  webhookId: string;
  deliveryKey: string;
  receivedAt: string;
  expiresAt: string;
  /**
   * When set, every expired claim (across all webhooks) at or before this
   * instant is swept first. Callers pass this on a sampled cadence so the
   * sweep does not run on every delivery.
   */
  sweepExpiredBefore: string | null;
}

export interface ReleaseInboundWebhookDeliveryInput {
  webhookId: string;
  deliveryKey: string;
}

export interface RecordInboundWebhookDeliveryStatsInput {
  webhookId: string;
  receivedAt: string;
  lastStatus: number;
  updatedAt: string;
}

// ─── Shared webhook task / notification writes ──────────────────────────────

/**
 * A task insert produced by a webhook receiver. Optional keys are omitted from
 * the statement entirely when `undefined`, so the column keeps its schema
 * default — matching the behavior each route relied on before this layer.
 */
export interface WebhookTaskInsert {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  statusReason?: string | null;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  sourceListId?: string | null;
  sourceListName?: string | null;
  assignee?: string | null;
  metadata?: Record<string, unknown>;
  syncStatus?: string;
  lastSyncedAt: string;
}

/** A sparse task update; absent keys are left untouched. */
export interface WebhookTaskUpdate {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  completedAt?: string | null;
  statusReason?: string | null;
  updatedAt?: string;
  syncStatus?: string;
  lastSyncedAt?: string;
}

/** The task lifecycle fields a webhook receiver needs before it writes. */
export interface WebhookTaskIdentity {
  id: string;
  status: string;
  completedAt: string | null;
  statusReason: string | null;
}

export interface WebhookNotificationInsert {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body?: string | null;
  level: string;
  levelRank?: number;
  category: string;
  templateKey?: string | null;
  state?: string;
  isActionable: boolean;
  primaryActionId?: string | null;
  receivedAt: string;
  sortAt: string;
  expiresAt?: string | null;
  relatedTaskId?: string | null;
  metadata?: Record<string, unknown>;
  presentation?: Record<string, unknown>;
}

/** A sparse notification update; absent keys are left untouched. */
export interface WebhookNotificationUpdate {
  sourceId?: string;
  connectorType?: string;
  connectorInstanceId?: string;
  title?: string;
  body?: string | null;
  level?: string;
  levelRank?: number;
  category?: string;
  state?: string;
  isActionable?: boolean;
  receivedAt?: string;
  sortAt?: string;
  expiresAt?: string | null;
  relatedTaskId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WebhookNotificationAction {
  id: string;
  actionType: string;
  label: string;
  icon?: string | null;
  variant: string;
  isPrimary: boolean;
  sortOrder: number;
  payload: Record<string, unknown>;
  opensExternal: boolean;
  createdBy: string;
}

/**
 * Replaces every `open_url` action on a notification. A `null` url deletes the
 * existing ones without inserting a replacement.
 */
export interface WebhookOpenUrlActionSync {
  url: string | null;
  label: string;
}

/** The projection the keyword/semantic search indexes consume. */
export interface WebhookSearchableNotification {
  id: string;
  title: string;
  body: string | null;
  category: string | null;
  connectorType: string | null;
}

export interface CreateWebhookNotificationInput {
  notification: WebhookNotificationInsert;
  /** Extra actions written in the same transaction as the notification. */
  actions?: readonly WebhookNotificationAction[];
  /** When present, `open_url` actions are synchronized after the insert. */
  openUrlAction?: WebhookOpenUrlActionSync;
}

export interface UpsertWebhookNotificationInput {
  match: { connectorType: string; sourceId: string };
  insert: WebhookNotificationInsert;
  update: WebhookNotificationUpdate;
  openUrlAction?: WebhookOpenUrlActionSync;
}

export interface UpsertWebhookNotificationResult {
  id: string;
  created: boolean;
  search: WebhookSearchableNotification;
}

export interface SnoozeWebhookNotificationInput {
  connectorType: string;
  sourceId: string;
  snoozedUntil: string | null;
  metadata: Record<string, unknown>;
}

// ─── Inbound webhook alert ingestion ────────────────────────────────────────

/**
 * The inbound `/receive` alert path. Unlike the n8n and RyMessage receivers,
 * this one goes through the durable push-delivery pipeline, so the result
 * reports whether a pending delivery event was created and the dispatcher
 * should be woken.
 */
export interface CreateInboundWebhookAlertInput {
  notification: WebhookNotificationInsert;
  action: WebhookNotificationAction | null;
}

export interface CreateInboundWebhookAlertResult {
  id: string;
  created: boolean;
  pendingDelivery: boolean;
}

// ─── Outbound webhook subscriptions ─────────────────────────────────────────

export interface OutboundWebhookRecord {
  id: string;
  name: string;
  url: string;
  /** Signing secret; required by the signed-delivery transport. */
  secret: string | null;
  eventTypes: unknown;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: number | null;
  createdAt: string;
}

export interface CreateOutboundWebhookInput {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: readonly string[];
  createdAt: string;
}

export interface OutboundWebhookPatch {
  name?: string;
  url?: string;
  secret?: string | null;
  enabled?: boolean;
  eventTypes?: readonly string[];
}

// ─── Integration configuration (n8n) ────────────────────────────────────────

export interface IntegrationConfigRecord {
  id: string;
  type: string;
  name: string;
  baseUrl: string | null;
  /** Upstream credential; required to call the integration's own API. */
  apiKey: string | null;
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SaveIntegrationConfigInput {
  id: string;
  type: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateIntegrationConfigSettingsInput {
  id: string;
  settings: Record<string, unknown>;
  updatedAt: string;
}

// ─── Per-connector webhook receiver ─────────────────────────────────────────

export interface ConnectorWebhookConfig {
  id: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface WebhookSyncLogEntry {
  id: string;
  connectorId: string;
  success: boolean;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  notificationsAdded: number;
  errors: string;
  syncedAt: string;
}

// ─── Ports ──────────────────────────────────────────────────────────────────

export interface InboundWebhookRepository {
  list(): Promise<InboundWebhookSummary[]>;
  create(input: CreateInboundWebhookInput): Promise<void>;
  update(input: UpdateInboundWebhookInput): Promise<UpdateInboundWebhookOutcome>;
  delete(id: string): Promise<DeleteInboundWebhookOutcome>;
  listLog(input: ListInboundWebhookLogInput): Promise<InboundWebhookLogEntry[]>;
  appendLog(input: AppendInboundWebhookLogInput): Promise<void>;
  findForDelivery(id: string): Promise<InboundWebhookDeliveryConfig | null>;
  /** Atomically claims a delivery key. `false` means it is a replay. */
  claimDelivery(input: ClaimInboundWebhookDeliveryInput): Promise<boolean>;
  releaseDelivery(input: ReleaseInboundWebhookDeliveryInput): Promise<void>;
  recordDeliveryStats(input: RecordInboundWebhookDeliveryStatsInput): Promise<void>;
  createTask(input: WebhookTaskInsert): Promise<void>;
  createAlert(input: CreateInboundWebhookAlertInput): Promise<CreateInboundWebhookAlertResult>;
}

export interface OutboundWebhookRepository {
  list(): Promise<OutboundWebhookRecord[]>;
  find(id: string): Promise<OutboundWebhookRecord | null>;
  create(input: CreateOutboundWebhookInput): Promise<void>;
  update(id: string, patch: OutboundWebhookPatch): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IntegrationConfigRepository {
  find(id: string): Promise<IntegrationConfigRecord | null>;
  save(input: SaveIntegrationConfigInput): Promise<void>;
  updateSettings(input: UpdateIntegrationConfigSettingsInput): Promise<void>;
}

export interface WebhookIngestRepository {
  findConnector(connectorId: string): Promise<ConnectorWebhookConfig | null>;
  findTaskBySourceId(sourceId: string): Promise<WebhookTaskIdentity | null>;
  createTask(input: WebhookTaskInsert): Promise<void>;
  updateTask(id: string, values: WebhookTaskUpdate): Promise<void>;
  createNotification(
    input: CreateWebhookNotificationInput,
  ): Promise<WebhookSearchableNotification>;
  upsertNotificationBySource(
    input: UpsertWebhookNotificationInput,
  ): Promise<UpsertWebhookNotificationResult>;
  /** Removes a notification and its actions. Resolves to the deleted id, or `null`. */
  deleteNotificationBySource(
    match: { connectorType: string; sourceId: string },
  ): Promise<string | null>;
  snoozeNotificationBySource(
    input: SnoozeWebhookNotificationInput,
  ): Promise<string | null>;
  appendSyncLog(entry: WebhookSyncLogEntry): Promise<void>;
}

/**
 * The whole Layer L20 surface, registered atomically: a backend either
 * supports every webhook configuration/delivery/log surface or none of them.
 */
export interface WebhookIntegrationsPersistence {
  inbound: InboundWebhookRepository;
  outbound: OutboundWebhookRepository;
  integrations: IntegrationConfigRepository;
  ingest: WebhookIngestRepository;
}
