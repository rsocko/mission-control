import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ConnectorConfig, NotificationLevel } from '@/types';
import {
  getNotificationLevelRank,
  isNotificationLevel,
  notificationMeetsMinimumLevel,
  normalizeNotificationLevel,
} from '@/lib/notifications/levels';
import {
  FINANCE_NOTIFICATION_TYPES,
  financeNotificationCatalogKey,
} from '@/lib/notifications/push-policy/catalogs';
import { isPushPreview } from '@/lib/notifications/push-policy/catalog';
import {
  resolveNotificationPushPolicy,
  type NotificationPushRuleValues,
  type ResolvedNotificationPushPolicy,
} from '@/lib/notifications/push-policy/policy';
import { MAX_NOTIFICATION_PUSHES_PER_HOUR } from '@/lib/notifications/push-policy/constants';
import { redactPushText } from '@/lib/notifications/push-text';
import {
  legacyStateFromLifecycle,
  needsAttention,
  shouldReopenForSourceActivity,
} from '@/lib/notifications/lifecycle';
import { getTimezone } from '@/lib/mode';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import { getApnsConfiguration, isApnsConfigured } from '@/lib/push/apns-config';
import type {
  ConnectorExecutionRepositories,
  ConnectorNotificationCommand,
  ConnectorTaskRecord,
  ConnectorTaskUpdate,
  DeletionCandidateRecord,
  DeletionIdentityState,
  GitHubDeletionFenceRecord,
  PullTag,
  RetentionDetailRecord,
  SourceListRecord,
} from '@/db/persistence/connector-execution';
import {
  UnsupportedConnectorExecutionError,
} from '@/db/persistence/connector-execution';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import { cleanupTaskAssociations } from './task-deletion';

type Client = Pool | PoolClient;

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

const TASK_COLUMNS = `
  id,
  source_id AS "sourceId",
  connector_type AS "connectorType",
  connector_instance_id AS "connectorInstanceId",
  title,
  description,
  status,
  local_disposition AS "localDisposition",
  priority,
  planning_horizon AS "planningHorizon",
  due_date AS "dueDate",
  push_count AS "pushCount",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt",
  recurrence_generated_from_task_id AS "recurrenceGeneratedFromTaskId",
  parent_id AS "parentId",
  depth,
  is_checklist_item AS "isChecklistItem",
  source_list_id AS "sourceListId",
  source_list_name AS "sourceListName",
  assignee,
  micro_status AS "microStatus",
  status_reason AS "statusReason",
  metadata,
  sync_status AS "syncStatus",
  last_synced_at AS "lastSyncedAt",
  push_retry_count AS "pushRetryCount",
  kanban_column AS "kanbanColumn",
  kanban_order AS "kanbanOrder",
  snoozed_until AS "snoozedUntil",
  reminder_at AS "reminderAt",
  reminder_relative AS "reminderRelative",
  reminder_due_time AS "reminderDueTime",
  effort,
  is_bulk_import AS "isBulkImport"
`;

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTask(row: ConnectorTaskRecord): ConnectorTaskRecord {
  return { ...row, metadata: objectValue(row.metadata) };
}

async function getTask(client: Client, id: string, lock = false): Promise<ConnectorTaskRecord | null> {
  const [row] = await query<ConnectorTaskRecord>(
    client,
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return row ? mapTask(row) : null;
}

const TASK_UPDATE_COLUMNS: Record<keyof ConnectorTaskUpdate, string> = {
  sourceId: 'source_id',
  connectorType: 'connector_type',
  connectorInstanceId: 'connector_instance_id',
  title: 'title',
  description: 'description',
  status: 'status',
  localDisposition: 'local_disposition',
  priority: 'priority',
  planningHorizon: 'planning_horizon',
  dueDate: 'due_date',
  pushCount: 'push_count',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  completedAt: 'completed_at',
  recurrenceGeneratedFromTaskId: 'recurrence_generated_from_task_id',
  parentId: 'parent_id',
  depth: 'depth',
  isChecklistItem: 'is_checklist_item',
  sourceListId: 'source_list_id',
  sourceListName: 'source_list_name',
  assignee: 'assignee',
  microStatus: 'micro_status',
  statusReason: 'status_reason',
  metadata: 'metadata',
  syncStatus: 'sync_status',
  lastSyncedAt: 'last_synced_at',
  pushRetryCount: 'push_retry_count',
  kanbanColumn: 'kanban_column',
  kanbanOrder: 'kanban_order',
  snoozedUntil: 'snoozed_until',
  reminderAt: 'reminder_at',
  reminderRelative: 'reminder_relative',
  reminderDueTime: 'reminder_due_time',
  effort: 'effort',
  isBulkImport: 'is_bulk_import',
};

async function updateTask(
  client: Client,
  taskId: string,
  values: ConnectorTaskUpdate,
  suffix = '',
  suffixParams: readonly unknown[] = [],
): Promise<number> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined) as Array<
    [keyof ConnectorTaskUpdate, unknown]
  >;
  if (entries.length === 0) return 0;
  const assignments = entries.map(
    ([key], index) => `${TASK_UPDATE_COLUMNS[key]} = $${index + 1}`,
  ).join(', ');
  const taskIndex = entries.length + 1;
  const suffixStart = taskIndex + 1;
  let numberedSuffix = suffix;
  for (let index = suffixParams.length - 1; index >= 0; index--) {
    numberedSuffix = numberedSuffix.replaceAll(`?${index + 1}`, `$${suffixStart + index}`);
  }
  const result = await client.query(
    `UPDATE tasks SET ${assignments} WHERE id = $${taskIndex} ${numberedSuffix}`,
    [...entries.map(([, value]) => value), taskId, ...suffixParams],
  );
  return result.rowCount ?? 0;
}

const TASK_INSERT_COLUMNS = [
  'id',
  'source_id',
  'connector_type',
  'connector_instance_id',
  'title',
  'description',
  'status',
  'local_disposition',
  'priority',
  'planning_horizon',
  'due_date',
  'push_count',
  'created_at',
  'updated_at',
  'completed_at',
  'recurrence_generated_from_task_id',
  'parent_id',
  'depth',
  'is_checklist_item',
  'source_list_id',
  'source_list_name',
  'assignee',
  'micro_status',
  'status_reason',
  'metadata',
  'sync_status',
  'last_synced_at',
  'push_retry_count',
  'kanban_column',
  'kanban_order',
  'snoozed_until',
  'reminder_at',
  'reminder_relative',
  'reminder_due_time',
  'effort',
  'is_bulk_import',
] as const;

function taskInsertValues(task: ConnectorTaskRecord): unknown[] {
  return [
    task.id,
    task.sourceId,
    task.connectorType,
    task.connectorInstanceId,
    task.title,
    task.description,
    task.status,
    task.localDisposition,
    task.priority,
    task.planningHorizon,
    task.dueDate,
    task.pushCount,
    task.createdAt,
    task.updatedAt,
    task.completedAt,
    task.recurrenceGeneratedFromTaskId,
    task.parentId,
    task.depth,
    task.isChecklistItem,
    task.sourceListId,
    task.sourceListName,
    task.assignee,
    task.microStatus,
    task.statusReason,
    task.metadata,
    task.syncStatus,
    task.lastSyncedAt,
    task.pushRetryCount,
    task.kanbanColumn,
    task.kanbanOrder,
    task.snoozedUntil,
    task.reminderAt,
    task.reminderRelative,
    task.reminderDueTime,
    task.effort,
    task.isBulkImport,
  ];
}

async function insertTask(
  client: Client,
  task: ConnectorTaskRecord,
): Promise<boolean> {
  const result = await client.query(
    `
      INSERT INTO tasks (${TASK_INSERT_COLUMNS.join(', ')})
      VALUES (${TASK_INSERT_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
      ON CONFLICT(source_id, connector_instance_id) DO NOTHING
    `,
    taskInsertValues(task),
  );
  return result.rowCount === 1;
}

async function upsertTag(client: Client, tag: PullTag): Promise<string> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tag.slug]);
  const [existing] = await query<{ id: string }>(
    client,
    'SELECT id FROM tags WHERE slug = $1 LIMIT 1',
    [tag.slug],
  );
  if (existing) {
    if (tag.color) await client.query('UPDATE tags SET color = $1 WHERE id = $2', [tag.color, existing.id]);
    return existing.id;
  }
  const id = tag.id ?? randomUUID();
  await client.query(
    `
      INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      tag.name,
      tag.slug,
      tag.type || 'source',
      tag.source ?? null,
      tag.color ?? null,
      tag.confirmed ?? true,
      new Date().toISOString(),
    ],
  );
  const [persisted] = await query<{ id: string }>(
    client,
    'SELECT id FROM tags WHERE slug = $1 LIMIT 1',
    [tag.slug],
  );
  return persisted.id;
}

async function replaceSourceTags(
  client: Client,
  taskId: string,
  tags: readonly PullTag[],
): Promise<void> {
  await client.query(
    `
      DELETE FROM task_tags
      WHERE task_id = $1
        AND tag_id IN (SELECT id FROM tags WHERE type = 'source')
    `,
    [taskId],
  );
  for (const tag of tags) {
    const tagId = await upsertTag(client, tag);
    await client.query(
      `
        INSERT INTO task_tags (task_id, tag_id)
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM task_tags WHERE task_id = $1 AND tag_id = $2
        )
      `,
      [taskId, tagId],
    );
  }
}

async function assertGenericTaskMutationSupported(
  client: Client,
  taskId: string,
): Promise<void> {
  const task = await getTask(client, taskId, true);
  if (!task) return;
  if (task.connectorType === 'github-issues') {
    throw new UnsupportedConnectorExecutionError('GitHub identity-backed deletion or retention');
  }
  const [unsupported] = await query<{
    dependencies: string;
    projects: string;
    phases: string;
    linkedSources: string;
  }>(
    client,
    `
      SELECT
        (SELECT count(*) FROM task_dependencies
          WHERE task_id = $1 OR depends_on_task_id = $1)::text AS dependencies,
        (SELECT count(*) FROM task_projects WHERE task_id = $1)::text AS projects,
        (SELECT count(*) FROM project_phase_items WHERE task_id = $1)::text AS phases,
        (SELECT count(*) FROM task_linked_sources WHERE task_id = $1)::text AS "linkedSources"
    `,
    [taskId],
  );
  if (
    Number(unsupported.dependencies) > 0
    || Number(unsupported.projects) > 0
    || Number(unsupported.phases) > 0
    || Number(unsupported.linkedSources) > 0
  ) {
    throw new UnsupportedConnectorExecutionError(
      'identity, dependency, or project relationship mutation',
    );
  }
}

type CapturedGitHubDeletionFence = Omit<GitHubDeletionFenceRecord, 'sourceId'>;

/**
 * Freezes the GitHub identity facts a deletion is authorized against: the
 * durable identity epoch, the active task binding, and the current locator. The
 * caller re-reads this inside the archival transaction so a concurrent repoint,
 * rebind, or epoch bump turns the delete into a no-op.
 */
async function captureGitHubDeletionFence(
  client: Client,
  connectorId: string,
  taskId: string,
): Promise<CapturedGitHubDeletionFence> {
  const [control] = await query<{ modeRevision: number | null }>(
    client,
    `
      SELECT mode_revision AS "modeRevision"
      FROM github_identity_controls
      WHERE connector_instance_id = $1
      LIMIT 1
    `,
    [connectorId],
  );
  const [row] = await query<{
    issueEntityId: string | null;
    hostKey: string | null;
    bindingState: string | null;
    bindingRevision: string | null;
    repositoryEntityId: string | null;
    locatorRevision: number | null;
  }>(
    client,
    `
      SELECT
        entity.id AS "issueEntityId",
        entity.host_key AS "hostKey",
        binding.state AS "bindingState",
        binding.verified_at AS "bindingRevision",
        locator.repository_entity_id AS "repositoryEntityId",
        locator.locator_revision AS "locatorRevision"
      FROM external_entity_bindings AS binding
      LEFT JOIN external_entities AS entity ON entity.id = binding.external_entity_id
      LEFT JOIN external_entity_locators AS locator
        ON locator.external_entity_id = entity.id
        AND locator.valid_to IS NULL
      WHERE binding.connector_instance_id = $1
        AND binding.binding_type = 'task'
        AND binding.local_id = $2
      LIMIT 1
    `,
    [connectorId, taskId],
  );
  return {
    identityMode: GITHUB_IDENTITY_MODE,
    identityModeRevision: control?.modeRevision ?? 0,
    issueEntityId: row?.issueEntityId ?? null,
    repositoryEntityId: row?.repositoryEntityId ?? null,
    hostKey: row?.hostKey ?? null,
    locatorRevision: row?.locatorRevision ?? null,
    bindingState: row?.bindingState ?? null,
    bindingRevision: row?.bindingRevision ?? null,
  };
}

function sameGitHubDeletionFence(
  current: CapturedGitHubDeletionFence,
  expected: GitHubDeletionFenceRecord,
): boolean {
  return current.identityMode === expected.identityMode
    && current.identityModeRevision === expected.identityModeRevision
    && current.issueEntityId === expected.issueEntityId
    && current.repositoryEntityId === expected.repositoryEntityId
    && current.hostKey === expected.hostKey
    && current.locatorRevision === expected.locatorRevision
    && current.bindingState === expected.bindingState
    && current.bindingRevision === expected.bindingRevision;
}

async function deleteTaskRows(client: Client, taskId: string): Promise<void> {
  await cleanupTaskAssociations(client, [taskId]);
  await client.query(
    `
      WITH RECURSIVE descendants(id, depth, path) AS (
        SELECT id, 0, ARRAY[id] FROM tasks WHERE parent_id = $1 AND id <> $1
        UNION ALL
        SELECT child.id, descendants.depth + 1, descendants.path || child.id
        FROM tasks AS child
        JOIN descendants ON child.parent_id = descendants.id
        WHERE NOT (child.id = ANY(descendants.path))
      )
      UPDATE tasks
      SET parent_id = CASE WHEN parent_id = $1 THEN NULL ELSE parent_id END,
          depth = descendants.depth
      FROM descendants
      WHERE tasks.id = descendants.id
    `,
    [taskId],
  );
  await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

async function loadRetentionRecord(
  client: Client,
  syncLogId: string,
  detailIndex: number,
  lock = false,
): Promise<RetentionDetailRecord | null> {
  const [row] = await query<{ connectorId: string; syncedAt: string; details: unknown }>(
    client,
    `
      SELECT connector_id AS "connectorId", synced_at AS "syncedAt", details
      FROM sync_log WHERE id = $1${lock ? ' FOR UPDATE' : ''}
    `,
    [syncLogId],
  );
  if (!row) return null;
  const detail = arrayValue(row.details)[detailIndex];
  if (!detail || typeof detail !== 'object' || (detail as { action?: string }).action !== 'protected') {
    return null;
  }
  return {
    connectorId: row.connectorId,
    syncedAt: row.syncedAt,
    detail: detail as RetentionDetailRecord['detail'],
  };
}

async function writeRetentionDetail(
  client: PoolClient,
  syncLogId: string,
  detailIndex: number,
  detail: RetentionDetailRecord['detail'],
): Promise<void> {
  const [row] = await query<{ details: unknown }>(
    client,
    'SELECT details FROM sync_log WHERE id = $1 FOR UPDATE',
    [syncLogId],
  );
  const details = arrayValue(row.details);
  details[detailIndex] = detail;
  await client.query(
    'UPDATE sync_log SET details = $1 WHERE id = $2',
    [JSON.stringify(details), syncLogId],
  );
}

function legacyNotificationState(input: ConnectorNotificationCommand['input']): string {
  return legacyStateFromLifecycle({
    readState: input.readState,
    disposition: input.disposition ?? 'inbox',
    sourceState: input.sourceState,
  });
}

async function notificationDeliveryState(
  client: Client,
  channel: 'web_push' | 'apns',
): Promise<{ status: 'pending' | 'suppressed'; reason: string | null }> {
  if (channel === 'web_push') {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return { status: 'suppressed', reason: 'channel_unconfigured' };
    }
    const [subscription] = await query(client, `
      SELECT 1 FROM push_subscriptions WHERE platform = 'web' LIMIT 1
    `);
    return subscription
      ? { status: 'pending', reason: null }
      : { status: 'suppressed', reason: 'no_subscription' };
  }
  if (!isApnsConfigured()) {
    return { status: 'suppressed', reason: 'channel_unconfigured' };
  }
  const configuration = getApnsConfiguration();
  const [registration] = await query(
    client,
    `SELECT 1 FROM apns_registrations
     WHERE invalidated_at IS NULL AND environment = $1 AND topic = $2
     LIMIT 1`,
    [configuration.environment, configuration.topic],
  );
  return registration
    ? { status: 'pending', reason: null }
    : { status: 'suppressed', reason: 'no_subscription' };
}

interface PostgresNotificationPushRule {
      id: string;
      templateKey: string;
      enabled: boolean;
      minLevel: string;
      preview: string;
      maxPerHour: number | null;
    }

    function postgresPushRule(
      rule: PostgresNotificationPushRule | undefined,
      policyTemplateKey: string,
    ): NotificationPushRuleValues | null {
      if (!rule) return null;
      if (!isNotificationLevel(rule.minLevel) || !isPushPreview(rule.preview)) {
        throw new Error(`Stored notification push rule "${rule.id}" is invalid`);
      }
      if (
        rule.maxPerHour !== null
        && (
          !Number.isInteger(rule.maxPerHour)
          || rule.maxPerHour < 1
          || rule.maxPerHour > MAX_NOTIFICATION_PUSHES_PER_HOUR
        )
      ) {
        throw new Error(`Stored notification push rule "${rule.id}" has an invalid rate limit`);
      }
      return {
        templateKey: rule.templateKey === '*' ? '*' : policyTemplateKey,
        enabled: rule.enabled,
        minLevel: rule.minLevel,
        preview: rule.preview,
        maxPerHour: rule.maxPerHour,
      };
    }

    async function resolvePostgresFinancePushPolicy(
      client: PoolClient,
      input: ConnectorNotificationCommand['input'],
      level: NotificationLevel,
    ): Promise<ResolvedNotificationPushPolicy> {
      const policyTemplateKey = financeNotificationCatalogKey(input.templateKey ?? '');
      const rules = await query<PostgresNotificationPushRule>(
        client,
        `SELECT id, template_key AS "templateKey", enabled, min_level AS "minLevel",
                preview, max_per_hour AS "maxPerHour"
         FROM notification_push_rules
         WHERE connector_instance_id = $1
           AND template_key IN ($2, $3, '*')
         ORDER BY CASE
           WHEN template_key = $2 THEN 0
           WHEN template_key = $3 THEN 1
           ELSE 2
         END`,
        [input.connectorInstanceId, input.templateKey, policyTemplateKey],
      );
      const exact = rules.find((rule) => rule.templateKey !== '*');
      const wildcard = rules.find((rule) => rule.templateKey === '*');
      const connectorRows = await query<{ enabled: boolean; deletedAt: string | null }>(
        client,
        `SELECT enabled, deleted_at AS "deletedAt"
         FROM connector_configs WHERE id = $1`,
        [input.connectorInstanceId],
      );
      const connector = connectorRows[0];
      return resolveNotificationPushPolicy({
        templateKey: policyTemplateKey,
        level,
        catalog: FINANCE_NOTIFICATION_TYPES,
        exactRule: postgresPushRule(exact, policyTemplateKey),
        wildcardRule: postgresPushRule(wildcard, policyTemplateKey),
        connectorDeleted: !connector || connector.deletedAt !== null,
        connectorDisabled: connector ? !connector.enabled : false,
      });
    }

    function postgresBooleanSetting(value: unknown): boolean {
      if (typeof value === 'boolean') return value;
      return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as Record<string, unknown>).enabled === true;
    }

    function currentHour(now: Date, timezone: string): number {
      return Number.parseInt(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(now), 10);
    }

    function quietHour(hour: number, start: number | null, end: number | null): boolean {
      if (start === null || end === null) return false;
      return start <= end
        ? hour >= start && hour < end
        : hour >= start || hour < end;
    }

    async function financeDeliverySuppression(
      client: PoolClient,
      notification: {
        id: string;
        connectorInstanceId: string;
        templateKey: string | null;
        state: string;
        disposition: string;
        sourceState: string;
        readState: string;
        level: NotificationLevel;
      },
      policy: ResolvedNotificationPushPolicy,
      channel: 'web_push' | 'apns',
      now: Date,
    ): Promise<{ reason: string | null; gates: Record<string, boolean> }> {
      const [setting] = await query<{ value: unknown }>(
        client,
        `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
      );
      const channelEnabled = setting ? postgresBooleanSetting(setting.value) : true;
      const [preferences] = await query<{
        doNotDisturb: boolean;
        quietStart: number | null;
        quietEnd: number | null;
      }>(
        client,
        `SELECT do_not_disturb AS "doNotDisturb", quiet_start AS "quietStart",
                quiet_end AS "quietEnd"
         FROM push_preferences WHERE id = 'default'`,
      );
      const dnd = preferences?.doNotDisturb ?? false;
      const quietHours = preferences
        ? quietHour(currentHour(now, getTimezone()), preferences.quietStart, preferences.quietEnd)
        : false;
      const availability = await notificationDeliveryState(client, channel);
      const channelConfigured = availability.reason !== 'channel_unconfigured';
      const hasSubscriptions = availability.reason !== 'no_subscription';
      const gates = { channelEnabled, channelConfigured, dnd, quietHours, hasSubscriptions };
      if (!needsAttention(notification, now)) return { reason: 'not_attention_eligible', gates };
      if (!channelEnabled) return { reason: 'channel_disabled', gates };
      if (!channelConfigured) return { reason: 'channel_unconfigured', gates };
      if (dnd) return { reason: 'dnd', gates };
      if (quietHours) return { reason: 'quiet_hours', gates };
      if (!policy.enabled) return { reason: 'rule_disabled', gates };
      if (!policy.shouldPush) return { reason: 'below_minimum_level', gates };
      if (!hasSubscriptions) return { reason: 'no_subscription', gates };

      const since = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
      const [globalCount] = await query<{ count: string }>(
        client,
        `SELECT COUNT(DISTINCT notification_id) AS count
         FROM notification_delivery_events
         WHERE created_at >= $1 AND status IN ('pending', 'sending', 'sent', 'partial')`,
        [since],
      );
      const configuredLimit = Number.parseInt(process.env.PUSH_GLOBAL_MAX_PER_HOUR ?? '', 10);
      const globalLimit = Number.isInteger(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : 100;
      if (Number(globalCount?.count ?? 0) >= globalLimit) {
        return { reason: 'rate_limited', gates };
      }
      if (policy.maxPerHour !== null) {
        const templatePredicate = policy.sourceDetail === 'wildcard'
          ? ''
          : 'AND notification.template_key = $3';
        const params: unknown[] = [since, notification.connectorInstanceId];
        if (policy.sourceDetail !== 'wildcard') params.push(notification.templateKey ?? '');
        const [ruleCount] = await query<{ count: string }>(
          client,
          `SELECT COUNT(DISTINCT delivery.notification_id) AS count
           FROM notification_delivery_events delivery
           INNER JOIN notifications notification ON notification.id = delivery.notification_id
           WHERE delivery.created_at >= $1
             AND delivery.status IN ('pending', 'sending', 'sent', 'partial')
             AND notification.connector_instance_id = $2
             ${templatePredicate}`,
          params,
        );
        if (Number(ruleCount?.count ?? 0) >= policy.maxPerHour) {
          return { reason: 'rate_limited', gates };
        }
      }
      return { reason: null, gates };
}

async function ingestNotification(
  client: PoolClient,
  command: ConnectorNotificationCommand,
): Promise<{ id: string; created: boolean; pendingDelivery: boolean }> {
  const input = command.input;
  const normalized = normalizeNotificationLevel(input.level);
  const now = new Date().toISOString();
  const inserted = await query<{ id: string }>(
    client,
    `
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, body,
        level, level_rank, category, template_key, state, read_state,
        disposition, source_state, sync_state, source_resolved_at,
        last_source_activity_at, last_source_activity_key, last_source_synced_at,
        is_actionable, primary_action_id, received_at, sort_at, group_key,
        dedupe_key, related_task_id,
        related_project_id, related_entity_type, related_entity_id,
        navigation_target, metadata, presentation
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
        $25, $26, $27, $28, $29, $30, $31, $32
      )
      ON CONFLICT(source_id) DO NOTHING
      RETURNING id
    `,
    [
      input.id,
      input.sourceId,
      input.connectorType,
      input.connectorInstanceId,
      input.title,
      input.body,
      normalized.level,
      getNotificationLevelRank(normalized.level),
      input.category,
      input.templateKey,
      legacyNotificationState(command.input),
      input.readState,
      input.disposition ?? 'inbox',
      input.sourceState,
      input.syncState ?? 'synced',
      ['resolved', 'deleted'].includes(input.sourceState) ? now : null,
      input.sourceActivityAt ?? input.sortAt,
      input.sourceActivityKey,
      now,
      input.isActionable,
      input.primaryActionId,
      input.receivedAt,
      input.sortAt,
      input.groupKey ?? null,
      input.dedupeKey ?? null,
      input.relatedTaskId,
      input.relatedProjectId,
      input.relatedEntityType,
      input.relatedEntityId,
      input.navigationTarget,
      input.metadata,
      input.presentation,
    ],
  );
  const created = inserted.length === 1;
  const [stored] = await query<{
    id: string;
    connectorType: string;
    connectorInstanceId: string;
    readState: string;
    disposition: string;
    sourceState: string;
    lastSourceActivityAt: string | null;
    lastSourceActivityKey: string | null;
    sortAt: string;
    primaryActionId: string | null;
  }>(
    client,
    `
      SELECT
        id,
        connector_type AS "connectorType",
        connector_instance_id AS "connectorInstanceId",
        read_state AS "readState",
        disposition,
        source_state AS "sourceState",
        last_source_activity_at AS "lastSourceActivityAt",
        last_source_activity_key AS "lastSourceActivityKey",
        sort_at AS "sortAt",
        primary_action_id AS "primaryActionId"
      FROM notifications WHERE source_id = $1 FOR UPDATE
    `,
    [input.sourceId],
  );
  if (
    stored.connectorType !== input.connectorType
    || stored.connectorInstanceId !== input.connectorInstanceId
  ) {
    throw new Error(
      `Notification source identity "${input.sourceId}" belongs to a different connector instance`,
    );
  }
  let currentDisposition = stored.disposition;
  let currentReadState = stored.readState;
  if (!created) {
    const reopen = shouldReopenForSourceActivity(
      {
        disposition: stored.disposition,
        lastSourceActivityAt: stored.lastSourceActivityAt,
        lastSourceActivityKey: stored.lastSourceActivityKey,
      },
      {
        sourceState: input.sourceState,
        sourceActivityAt: input.sourceActivityAt,
        sourceActivityKey: input.sourceActivityKey,
      },
      input.reopenPolicy,
    );
    const disposition = reopen ? 'inbox' : stored.disposition;
    const readState = reopen ? input.readState : stored.readState;
    currentDisposition = disposition;
    currentReadState = readState;
    await client.query(
      `
        UPDATE notifications SET
          title = $1,
          body = $2,
          level = $3,
          level_rank = $4,
          category = $5,
          template_key = $6,
          state = $7,
          read_state = $8,
          disposition = $9,
          source_state = $10,
          source_resolved_at = CASE
            WHEN $10 IN ('resolved', 'deleted') THEN COALESCE(source_resolved_at, $11)
            ELSE NULL
          END,
          last_source_activity_at = COALESCE($12, last_source_activity_at),
          last_source_activity_key = COALESCE($13, last_source_activity_key),
          last_source_synced_at = $11,
          sort_at = CASE WHEN $14 THEN COALESCE($12, $11) ELSE sort_at END,
          group_key = $15,
          dedupe_key = $16,
          related_task_id = $17,
          related_project_id = $18,
          related_entity_type = $19,
          related_entity_id = $20,
          navigation_target = $21,
          metadata = $22,
          presentation = $23,
          is_actionable = $24,
          primary_action_id = $25
        WHERE id = $26
      `,
      [
        input.title,
        input.body,
        normalized.level,
        getNotificationLevelRank(normalized.level),
        input.category,
        input.templateKey,
        legacyStateFromLifecycle({
          readState: readState as Parameters<typeof legacyStateFromLifecycle>[0]['readState'],
          disposition: disposition as Parameters<typeof legacyStateFromLifecycle>[0]['disposition'],
          sourceState: input.sourceState,
        }),
        readState,
        disposition,
        input.sourceState,
        now,
        input.sourceActivityAt,
        input.sourceActivityKey,
        reopen,
        input.groupKey ?? null,
        input.dedupeKey ?? null,
        input.relatedTaskId,
        input.relatedProjectId,
        input.relatedEntityType,
        input.relatedEntityId,
        input.navigationTarget,
        input.metadata,
        input.presentation,
        input.isActionable,
        stored.primaryActionId,
        stored.id,
      ],
    );
  }
  if (created) {
    for (const action of command.actions) {
      if (action.notificationId !== stored.id) {
        throw new Error(`Notification action ${action.id} belongs to another notification`);
      }
      await client.query(
        `
          INSERT INTO notification_actions (
            id, notification_id, action_type, label, icon, variant, is_primary,
            sort_order, payload, opens_external, requires_confirmation, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
          )
        `,
        [
          action.id,
          action.notificationId,
          action.actionType,
          action.label,
          action.icon ?? null,
          action.variant,
          action.isPrimary,
          action.sortOrder,
          action.payload,
          action.opensExternal,
          action.requiresConfirmation,
          action.createdBy,
        ],
      );
    }
  }
  const systemDeliveryType = input.connectorType === 'system'
    && input.connectorInstanceId === 'push-triggers'
    && input.templateKey === 'task_reminder';
  if (input.connectorType === 'finance-manager') {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['notification-delivery-policy:finance'],
    );
  }
  const financePolicy = input.connectorType === 'finance-manager'
    ? await resolvePostgresFinancePushPolicy(client, input, normalized.level)
    : null;
  if (financePolicy && !financePolicy.eligible) {
    return { id: stored.id, created, pendingDelivery: false };
  }
  const [storedRule] = !financePolicy && input.templateKey
    ? await query<{ enabled: boolean; minLevel: string }>(
        client,
        `
          SELECT enabled, min_level AS "minLevel"
          FROM notification_push_rules
          WHERE connector_instance_id = $1
            AND template_key IN ($2, '*')
          ORDER BY CASE WHEN template_key = $2 THEN 0 ELSE 1 END
          LIMIT 1
        `,
        [input.connectorInstanceId, input.templateKey],
      )
    : [undefined];
  if (!systemDeliveryType && !storedRule && !financePolicy) {
    return { id: stored.id, created, pendingDelivery: false };
  }
  const lifecycle = {
    id: stored.id,
    connectorInstanceId: input.connectorInstanceId,
    templateKey: input.templateKey,
    state: legacyStateFromLifecycle({
      readState: currentReadState as Parameters<typeof legacyStateFromLifecycle>[0]['readState'],
      disposition: currentDisposition as Parameters<typeof legacyStateFromLifecycle>[0]['disposition'],
      sourceState: input.sourceState,
    }),
    disposition: currentDisposition,
    sourceState: input.sourceState,
    readState: currentReadState,
    level: normalized.level,
  };
  const deliveries: Array<{
    channel: 'web_push' | 'apns';
    status: 'pending' | 'suppressed';
    reason: string | null;
    gates?: Record<string, boolean>;
  }> = [];
  for (const channel of ['web_push', 'apns'] as const) {
    if (financePolicy) {
      const suppression = await financeDeliverySuppression(
        client,
        lifecycle,
        financePolicy,
        channel,
        new Date(now),
      );
      deliveries.push({
        channel,
        status: suppression.reason ? 'suppressed' : 'pending',
        reason: suppression.reason,
        gates: suppression.gates,
      });
      continue;
    }
    if (storedRule?.enabled === false) {
      deliveries.push({ channel, status: 'suppressed', reason: 'rule_disabled' });
      continue;
    }
    if (
      storedRule
      && !notificationMeetsMinimumLevel(
        normalized.level,
        normalizeNotificationLevel(storedRule.minLevel).level,
      )
    ) {
      deliveries.push({ channel, status: 'suppressed', reason: 'below_minimum_level' });
      continue;
    }
    const delivery = await notificationDeliveryState(client, channel);
    deliveries.push({ channel, ...delivery });
  }
  let pendingDelivery = false;
  for (const delivery of deliveries) {
    const payload = {
      notificationId: stored.id,
      title: redactPushText(input.title, 160),
      tag: `mc:${stored.id}`,
      url: input.navigationTarget ?? `/notifications?id=${encodeURIComponent(stored.id)}`,
      ...(financePolicy?.preview === 'title_and_body' && input.body
        ? { body: redactPushText(input.body, 512) }
        : {}),
    };
    const insertedDelivery = await client.query(
      `
        INSERT INTO notification_delivery_events (
          id, notification_id, channel, dedupe_key, status, suppression_reason,
          policy_snapshot, payload_snapshot, attempt_count, next_attempt_at,
          subscriptions_attempted, subscriptions_sent, subscriptions_failed,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 0, 0, 0, $10
        )
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id
      `,
      [
        randomUUID(),
        stored.id,
        delivery.channel,
        `${delivery.channel}:${stored.id}:${input.occurrenceKey}`,
        delivery.status,
        delivery.reason,
        {
          version: 1,
          channel: delivery.channel,
          connectorType: input.connectorType,
          connectorInstanceId: input.connectorInstanceId,
          templateKey: input.templateKey,
          ...(financePolicy
            ? {
                source: financePolicy.source,
                sourceDetail: financePolicy.sourceDetail,
                minLevel: financePolicy.minLevel,
                preview: financePolicy.preview,
                maxPerHour: financePolicy.maxPerHour,
                gates: delivery.gates,
              }
            : {}),
          decision: delivery.status,
          suppressionReason: delivery.reason,
        },
        payload,
        delivery.status === 'pending' ? now : null,
        now,
      ],
    );
    pendingDelivery ||= insertedDelivery.rowCount === 1 && delivery.status === 'pending';
  }
  return { id: stored.id, created, pendingDelivery };
}

export function ingestPostgresConnectorNotificationInTransaction(
  client: PoolClient,
  command: ConnectorNotificationCommand,
): Promise<{ id: string; created: boolean; pendingDelivery: boolean }> {
  return ingestNotification(client, command);
}

export function createPostgresConnectorExecutionRepositories(
  pool: Pool,
): ConnectorExecutionRepositories {
  return {
    lists: {
      async list(connectorId) {
        return query<SourceListRecord>(
          pool,
          `
            SELECT
              id,
              connector_instance_id AS "connectorInstanceId",
              source_id AS "sourceId",
              name,
              type,
              task_count AS "taskCount",
              last_synced_at AS "lastSyncedAt",
              well_known_list_name AS "wellKnownListName",
              group_id AS "groupId",
              sort_order AS "sortOrder",
              hidden,
              last_known_remote_name AS "lastKnownRemoteName",
              user_display_name AS "userDisplayName",
              icon,
              icon_color AS "iconColor"
            FROM source_lists WHERE connector_instance_id = $1
          `,
          [connectorId],
        );
      },

      async applyDiscovery(command) {
        await transaction(pool, async (client) => {
          for (const record of command.upserts) {
            if (record.connectorInstanceId !== command.connectorId) {
              throw new Error(`Source list ${record.id} belongs to another connector`);
            }
            await client.query(
              `SELECT pg_advisory_xact_lock(hashtext($1))`,
              [`source-list:${record.id}`],
            );
            const [existing] = await query<{ connectorInstanceId: string }>(
              client,
              `
                SELECT connector_instance_id AS "connectorInstanceId"
                FROM source_lists
                WHERE id = $1
                FOR UPDATE
              `,
              [record.id],
            );
            if (existing && existing.connectorInstanceId !== command.connectorId) {
              throw new Error(`Source list ${record.id} belongs to another connector`);
            }
            await client.query(
              `
                INSERT INTO source_lists (
                  id, connector_instance_id, source_id, name, type, task_count,
                  last_synced_at, well_known_list_name, last_known_remote_name
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT(id) DO UPDATE SET
                  source_id = EXCLUDED.source_id,
                  name = EXCLUDED.name,
                  type = EXCLUDED.type,
                  task_count = EXCLUDED.task_count,
                  last_synced_at = EXCLUDED.last_synced_at,
                  well_known_list_name = EXCLUDED.well_known_list_name,
                  last_known_remote_name = EXCLUDED.last_known_remote_name
              `,
              [
                record.id,
                record.connectorInstanceId,
                record.sourceId,
                record.name,
                record.type,
                record.taskCount,
                record.lastSyncedAt,
                record.wellKnownListName,
                record.lastKnownRemoteName,
              ],
            );
          }
          for (const stale of command.stale) {
            if (stale.action === 'mark-unobserved') {
              await client.query(
                `
                  UPDATE source_lists SET last_synced_at = NULL
                  WHERE id = $1 AND connector_instance_id = $2
                `,
                [stale.id, command.connectorId],
              );
            } else {
              await client.query(
                'DELETE FROM source_lists WHERE id = $1 AND connector_instance_id = $2',
                [stale.id, command.connectorId],
              );
            }
          }
        });
      },

      async assignFolderGroups(input) {
        return transaction(pool, async (client) => {
          const rows = await query<{ id: string; name: string; sourceId: string | null }>(
            client,
            'SELECT id, name, source_id AS "sourceId" FROM list_groups FOR UPDATE',
          );
          const bySource = new Map(rows.flatMap((row) => (
            row.sourceId ? [[row.sourceId, row.id] as const] : []
          )));
          const byName = new Map(rows.map((row) => [row.name, row.id]));
          let sortOrder = rows.length;
          for (const group of input.groups) {
            let id = bySource.get(group.sourceId);
            if (!id) {
              id = byName.get(group.name);
              if (id) {
                await client.query(
                  'UPDATE list_groups SET source_id = COALESCE(source_id, $1) WHERE id = $2',
                  [group.sourceId, id],
                );
              } else {
                id = `lg-${randomUUID().slice(0, 8)}`;
                await client.query(
                  `
                    INSERT INTO list_groups (id, name, source_id, sort_order, created_at)
                    VALUES ($1, $2, $3, $4, $5)
                  `,
                  [id, group.name, group.sourceId, sortOrder++, input.now],
                );
                byName.set(group.name, id);
              }
              bySource.set(group.sourceId, id);
            }
          }
          let assigned = 0;
          for (const list of input.lists) {
            const groupId = bySource.get(list.parentFolderGroupId);
            if (!groupId) continue;
            const result = await client.query(
              `
                UPDATE source_lists SET group_id = $1
                WHERE source_id = $2 AND group_id IS NULL
              `,
              [groupId, list.sourceId],
            );
            assigned += result.rowCount ?? 0;
          }
          return assigned;
        });
      },

      async removeLegacyProjectLists(connectorId) {
        await transaction(pool, async (client) => {
          await client.query(
            `DELETE FROM source_lists WHERE connector_instance_id = $1 AND type = 'project'`,
            [connectorId],
          );
          await client.query(
            `
              UPDATE tasks SET source_list_id = NULL, source_list_name = NULL
              WHERE connector_instance_id = $1 AND source_list_id LIKE 'project:%'
            `,
            [connectorId],
          );
        });
      },
    },

    pushes: {
      async listCandidates(input) {
        if (input.taskIds && input.taskIds.length === 0) return [];
        const params: unknown[] = [input.connectorId];
        let idClause = '';
        if (input.taskIds) {
          params.push(input.taskIds);
          idClause = 'AND id = ANY($2::text[])';
        }
        const statuses = input.includePushing
          ? `('pending_push', 'push_error', 'pushing')`
          : `('pending_push', 'push_error')`;
        return (await query<ConnectorTaskRecord>(
          pool,
          `
            SELECT ${TASK_COLUMNS}
            FROM tasks
            WHERE connector_instance_id = $1
              AND (
                sync_status IN ${statuses}
                OR source_id LIKE 'local:%'
                OR (
                  is_checklist_item = true
                  AND source_id = id
                  AND sync_status <> 'push_failed'
                )
              )
              ${idClause}
          `,
          params,
        )).map(mapTask);
      },

      async listSourceIds(taskIds) {
        if (taskIds.length === 0) return [];
        return query<{ id: string; sourceId: string }>(
          pool,
          'SELECT id, source_id AS "sourceId" FROM tasks WHERE id = ANY($1::text[])',
          [taskIds],
        );
      },

      async markSynced(taskId, now, updates = {}) {
        return (await updateTask(pool, taskId, {
          ...updates,
          syncStatus: 'synced',
          lastSyncedAt: now,
        })) === 1;
      },

      async markFailure(taskId, status, retryCount) {
        return (await updateTask(pool, taskId, {
          syncStatus: status,
          pushRetryCount: retryCount,
        })) === 1;
      },

      async claim(taskId, leaseToken, staleBefore) {
        const result = await pool.query(
          `
            UPDATE tasks
            SET sync_status = 'pushing', last_synced_at = $1
            WHERE id = $2
              AND (
                sync_status IN ('pending_push', 'push_error', 'pushing')
                OR source_id LIKE 'local:%'
                OR (
                  is_checklist_item = true
                  AND source_id = id
                  AND sync_status <> 'push_failed'
                )
              )
              AND (
                sync_status <> 'pushing'
                OR last_synced_at IS NULL
                OR last_synced_at < $3
              )
          `,
          [leaseToken, taskId, staleBefore],
        );
        return result.rowCount === 1;
      },

      async loadClaimed(taskId, leaseToken) {
        const [row] = await query<ConnectorTaskRecord>(
          pool,
          `
            SELECT ${TASK_COLUMNS} FROM tasks
            WHERE id = $1 AND sync_status = 'pushing' AND last_synced_at = $2
          `,
          [taskId, leaseToken],
        );
        return row ? mapTask(row) : null;
      },

      async heartbeat(taskId, leaseToken, renewedToken) {
        const result = await pool.query(
          `
            UPDATE tasks SET last_synced_at = $1
            WHERE id = $2 AND sync_status = 'pushing' AND last_synced_at = $3
          `,
          [renewedToken, taskId, leaseToken],
        );
        return result.rowCount === 1;
      },

      async release(input) {
        const params: unknown[] = [
          input.syncStatus,
          input.now,
          input.taskId,
          input.leaseToken,
        ];
        const versionClause = input.expectedTaskVersion === undefined
          ? ''
          : `AND updated_at = $${params.push(input.expectedTaskVersion)}`;
        const result = await pool.query(
          `
            UPDATE tasks SET sync_status = $1, last_synced_at = $2
            WHERE id = $3 AND sync_status = 'pushing' AND last_synced_at = $4
              ${versionClause}
          `,
          params,
        );
        return result.rowCount === 1;
      },

      async complete(input) {
        return transaction(pool, async (client) => {
          const suffixParams = [
            input.leaseToken,
            ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
          ];
          const completed = await updateTask(
            client,
            input.taskId,
            {
              sourceId: input.sourceId,
              syncStatus: 'synced',
              lastSyncedAt: input.now,
              ...(input.metadata ? { metadata: input.metadata } : {}),
              ...(input.localUpdates ?? {}),
            },
            `AND sync_status = 'pushing' AND last_synced_at = ?1 ${
              input.expectedTaskVersion === undefined ? '' : 'AND updated_at = ?2'
            }`,
            suffixParams,
          );
          if (completed === 1 || input.createdFromSourceId === undefined) {
            return completed === 1;
          }

          const [current] = await query<{
            sourceId: string;
            syncStatus: string;
            lastSyncedAt: string | null;
            metadata: unknown;
          }>(
            client,
            `
              SELECT
                source_id AS "sourceId",
                sync_status AS "syncStatus",
                last_synced_at AS "lastSyncedAt",
                metadata
              FROM tasks
              WHERE id = $1
              FOR UPDATE
            `,
            [input.taskId],
          );
          if (!current || current.sourceId !== input.createdFromSourceId) return false;
          const ownsLease = current.syncStatus === 'pushing'
            && current.lastSyncedAt === input.leaseToken;
          return (await updateTask(
            client,
            input.taskId,
            {
              sourceId: input.sourceId,
              ...(input.metadata
                ? { metadata: { ...objectValue(current.metadata), ...input.metadata } }
                : {}),
              ...(ownsLease
                ? { syncStatus: 'pending_push', lastSyncedAt: input.now }
                : {}),
            },
            'AND source_id = ?1',
            [input.createdFromSourceId],
          )) === 1;
        });
      },

      async fail(input) {
        const suffixParams = [
          input.leaseToken,
          ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
        ];
        return (await updateTask(
          pool,
          input.taskId,
          {
            syncStatus: input.syncStatus,
            lastSyncedAt: input.now,
            ...(input.pushRetryCount === undefined
              ? {}
              : { pushRetryCount: input.pushRetryCount }),
          },
          `AND sync_status = 'pushing' AND last_synced_at = ?1 ${
            input.expectedTaskVersion === undefined ? '' : 'AND updated_at = ?2'
          }`,
          suffixParams,
        )) === 1;
      },
    },

    pulls: {
      async loadSnapshot(connectorId, options = {}) {
        const tasks = (await query<ConnectorTaskRecord>(
          pool,
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE connector_instance_id = $1`,
          [connectorId],
        )).map(mapTask);
        const tags = await query<{ id: string; slug: string; type: string }>(
          pool,
          'SELECT id, slug, type FROM tags',
        );
        const archivedRecurringDuplicateSourceIds = options.includeArchivedRecurringDuplicates
          ? (await query<{ sourceId: string }>(
              pool,
              `
                SELECT source_id AS "sourceId" FROM sync_deletion_snapshots
                WHERE connector_id = $1
                  AND reason LIKE 'Duplicate open Microsoft To Do recurrence%'
              `,
              [connectorId],
            )).map((row) => row.sourceId)
          : [];
        const linkedSources = options.includeLinkedSources
          ? await query<{
              id: string;
              taskId: string;
              sourceId: string;
              entityProvider: string | null;
              entityHostKey: string | null;
              entityType: string | null;
              entityStableId: string | null;
            }>(
              pool,
              `
                SELECT
                  linked.id,
                  linked.task_id AS "taskId",
                  linked.source_id AS "sourceId",
                  entity.provider AS "entityProvider",
                  entity.host_key AS "entityHostKey",
                  entity.entity_type AS "entityType",
                  entity.stable_id AS "entityStableId"
                FROM task_linked_sources AS linked
                LEFT JOIN task_linked_source_entities AS association
                  ON association.linked_source_id = linked.id
                LEFT JOIN external_entities AS entity
                  ON entity.id = association.external_entity_id
                WHERE linked.connector_instance_id = $1
                  AND linked.connector_type = 'github-issues'
              `,
              [connectorId],
            )
          : [];
        return {
          tasks,
          tags,
          archivedRecurringDuplicateSourceIds,
          linkedSources,
        };
      },

      async updateLinkedSourceLocator(id, sourceId) {
        await pool.query(
          'UPDATE task_linked_sources SET source_id = $1 WHERE id = $2',
          [sourceId, id],
        );
      },

      async updateTaskSourceId(taskId, sourceId) {
        return (await pool.query(
          'UPDATE tasks SET source_id = $1 WHERE id = $2',
          [sourceId, taskId],
        )).rowCount === 1;
      },

      async adoptLocalTask(input) {
        return transaction(pool, async (client) => {
          const adopted = await client.query(
            `
              UPDATE tasks
              SET source_id = $1, sync_status = $2, last_synced_at = $3
              WHERE id = $4
                AND connector_instance_id = $5
                AND source_id LIKE 'local:%'
            `,
            [
              input.remoteSourceId,
              input.hasLocalEdits ? 'pending_push' : 'synced',
              input.now,
              input.taskId,
              input.connectorId,
            ],
          );
          return adopted.rowCount === 1
            ? getTask(client, input.taskId)
            : (await query<ConnectorTaskRecord>(
              client,
              `
                SELECT ${TASK_COLUMNS} FROM tasks
                WHERE connector_instance_id = $1 AND source_id = $2
                LIMIT 1
              `,
              [input.connectorId, input.remoteSourceId],
            )).map(mapTask)[0]
              ?? null;
        });
      },

      async insertBatch(candidates) {
        return transaction(pool, async (client) => {
          const insertedIds = new Set<string>();
          for (const candidate of candidates) {
            if (await insertTask(client, candidate.task)) {
              insertedIds.add(candidate.task.id);
              await replaceSourceTags(client, candidate.task.id, candidate.tags);
            }
          }
          const records: ConnectorTaskRecord[] = [];
          for (const candidate of candidates) {
            const [row] = await query<ConnectorTaskRecord>(
              client,
              `
                SELECT ${TASK_COLUMNS} FROM tasks
                WHERE connector_instance_id = $1 AND source_id = $2
                LIMIT 1
              `,
              [candidate.task.connectorInstanceId, candidate.task.sourceId],
            );
            if (row) records.push(mapTask(row));
          }
          return { insertedIds, records };
        });
      },

      async findBySourceIds(connectorId, sourceIds) {
        if (sourceIds.length === 0) return [];
        return (await query<ConnectorTaskRecord>(
          pool,
          `
            SELECT ${TASK_COLUMNS} FROM tasks
            WHERE connector_instance_id = $1 AND source_id = ANY($2::text[])
          `,
          [connectorId, sourceIds],
        )).map(mapTask);
      },

      async applyRemoteUpdate(input) {
        return transaction(pool, async (client) => {
          const changed = await updateTask(
            client,
            input.taskId,
            input.values,
            'AND sync_status = ?1',
            [input.expectedSyncStatus],
          );
          if (changed !== 1) return false;
          if (input.sourceTags) await replaceSourceTags(client, input.taskId, input.sourceTags);
          return true;
        });
      },

      async replaceSourceTags(taskId, tags) {
        await transaction(pool, (client) => replaceSourceTags(client, taskId, tags));
      },

      async listChecklistItems(connectorId) {
        return query<{
          id: string;
          sourceId: string;
          parentId: string | null;
        }>(
          pool,
          `
            SELECT id, source_id AS "sourceId", parent_id AS "parentId"
            FROM tasks
            WHERE connector_instance_id = $1 AND is_checklist_item = true
          `,
          [connectorId],
        );
      },

      async correctParents(corrections) {
        await transaction(pool, async (client) => {
          for (const correction of corrections) {
            await client.query(
              'UPDATE tasks SET parent_id = $1 WHERE id = $2',
              [correction.parentId, correction.taskId],
            );
          }
        });
      },

      async listChildren(taskId) {
        return (await query<{ id: string }>(
          pool,
          'SELECT id FROM tasks WHERE parent_id = $1',
          [taskId],
        )).map((row) => row.id);
      },

      async listTasks(connectorId) {
        return (await query<ConnectorTaskRecord>(
          pool,
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE connector_instance_id = $1`,
          [connectorId],
        )).map(mapTask);
      },

      async listStaleInProgress(connectorId) {
        return query<{
          id: string;
          sourceId: string;
          status: string;
          completedAt: string | null;
        }>(
          pool,
          `
            SELECT id, source_id AS "sourceId", status, completed_at AS "completedAt"
            FROM tasks
            WHERE connector_instance_id = $1 AND status = 'in_progress'
          `,
          [connectorId],
        );
      },

      async applyVerifiedTerminalStatus(input) {
        const result = await pool.query(
          `
            UPDATE tasks SET
              status = $1,
              completed_at = $2,
              sync_status = 'synced',
              last_synced_at = $3
            WHERE id = $4 AND status = $5
          `,
          [
            input.status,
            input.completedAt,
            input.now,
            input.taskId,
            input.expectedStatus,
          ],
        );
        return result.rowCount === 1;
      },
    },

    deletions: {
      async listCandidates(connectorId) {
        return query<DeletionCandidateRecord>(
          pool,
          `
            SELECT
              id,
              connector_id AS "connectorId",
              task_id AS "taskId",
              source_id AS "sourceId",
              first_missing_at AS "firstMissingAt",
              last_missing_at AS "lastMissingAt",
              missing_count AS "missingCount",
              identity_mode AS "identityMode",
              identity_mode_revision AS "identityModeRevision",
              issue_entity_id AS "issueEntityId",
              repository_entity_id AS "repositoryEntityId",
              host_key AS "hostKey",
              locator_revision AS "locatorRevision",
              binding_state AS "bindingState",
              binding_revision AS "bindingRevision"
            FROM sync_deletion_candidates WHERE connector_id = $1
          `,
          [connectorId],
        );
      },

      async listIdentityStates(connectorId) {
        return query<DeletionIdentityState>(
          pool,
          `
            SELECT
              task.id AS "localId",
              binding.external_entity_id AS "externalEntityId",
              entity.stable_id AS "stableId",
              binding.state AS "bindingState",
              backfill.state AS "backfillState",
              locator.locator_revision AS "locatorRevision",
              locator.repository_entity_id AS "repositoryEntityId",
              entity.host_key AS "hostKey",
              binding.verified_at AS "bindingRevision"
            FROM tasks AS task
            LEFT JOIN external_entity_bindings AS binding
              ON binding.connector_instance_id = task.connector_instance_id
              AND binding.binding_type = 'task'
              AND binding.local_id = task.id
              AND binding.state <> 'retired'
            LEFT JOIN external_entities AS entity
              ON entity.id = binding.external_entity_id
            LEFT JOIN external_entity_locators AS locator
              ON locator.external_entity_id = entity.id
              AND locator.valid_to IS NULL
            LEFT JOIN github_identity_backfill_items AS backfill
              ON backfill.connector_instance_id = task.connector_instance_id
              AND backfill.binding_type = 'task'
              AND backfill.local_id = task.id
            WHERE task.connector_instance_id = $1
          `,
          [connectorId],
        );
      },

      async clearCandidate(connectorId, sourceId) {
        await pool.query(
          'DELETE FROM sync_deletion_candidates WHERE connector_id = $1 AND source_id = $2',
          [connectorId, sourceId],
        );
      },

      async markPendingPush(taskId) {
        return (await pool.query(
          `UPDATE tasks SET sync_status = 'pending_push' WHERE id = $1`,
          [taskId],
        )).rowCount === 1;
      },

      async observeMissing(input) {
        return transaction(pool, async (client) => {
          const [existing] = input.expectedCandidateId
            ? await query<Pick<DeletionCandidateRecord, 'id' | 'identityMode'
              | 'identityModeRevision' | 'issueEntityId' | 'repositoryEntityId'
              | 'hostKey' | 'locatorRevision' | 'bindingState' | 'bindingRevision'>>(
                client,
                `
                  SELECT
                    id,
                    identity_mode AS "identityMode",
                    identity_mode_revision AS "identityModeRevision",
                    issue_entity_id AS "issueEntityId",
                    repository_entity_id AS "repositoryEntityId",
                    host_key AS "hostKey",
                    locator_revision AS "locatorRevision",
                    binding_state AS "bindingState",
                    binding_revision AS "bindingRevision"
                  FROM sync_deletion_candidates
                  WHERE id = $1 AND connector_id = $2 AND source_id = $3
                  FOR UPDATE
                `,
                [input.expectedCandidateId, input.connectorId, input.sourceId],
              )
            : [];
          if (!input.expectedCandidateId || !existing) {
            await client.query(
              `
                INSERT INTO sync_deletion_candidates (
                  id, connector_id, task_id, source_id, first_missing_at,
                  last_missing_at, missing_count, identity_mode,
                  identity_mode_revision, issue_entity_id, repository_entity_id,
                  host_key, locator_revision, binding_state, binding_revision
                ) VALUES (
                  $1, $2, $3, $4, $5, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13
                )
                ON CONFLICT(connector_id, source_id) DO UPDATE SET
                  task_id = EXCLUDED.task_id,
                  last_missing_at = EXCLUDED.last_missing_at,
                  missing_count = 1,
                  identity_mode = EXCLUDED.identity_mode,
                  identity_mode_revision = EXCLUDED.identity_mode_revision,
                  issue_entity_id = EXCLUDED.issue_entity_id,
                  repository_entity_id = EXCLUDED.repository_entity_id,
                  host_key = EXCLUDED.host_key,
                  locator_revision = EXCLUDED.locator_revision,
                  binding_state = EXCLUDED.binding_state,
                  binding_revision = EXCLUDED.binding_revision
              `,
              [
                randomUUID(),
                input.connectorId,
                input.taskId,
                input.sourceId,
                input.now,
                input.expectedFence.identityMode,
                input.expectedFence.identityModeRevision,
                input.expectedFence.issueEntityId,
                input.expectedFence.repositoryEntityId,
                input.expectedFence.hostKey,
                input.expectedFence.locatorRevision,
                input.expectedFence.bindingState,
                input.expectedFence.bindingRevision,
              ],
            );
            return 'quarantined';
          }
          const fenceKeys = [
            'identityMode',
            'identityModeRevision',
            'issueEntityId',
            'repositoryEntityId',
            'hostKey',
            'locatorRevision',
            'bindingState',
            'bindingRevision',
          ] as const;
          if (fenceKeys.some((key) => existing[key] !== input.expectedFence[key])) {
            await client.query('DELETE FROM sync_deletion_candidates WHERE id = $1', [existing.id]);
            return 'fence-reset';
          }
          await client.query(
            `
              UPDATE sync_deletion_candidates
              SET last_missing_at = $1, missing_count = missing_count + 1
              WHERE id = $2
            `,
            [input.now, existing.id],
          );
          return 'ready';
        });
      },

      async archiveAndDeleteTask(taskId, reason, expectedFence) {
        return transaction(pool, async (client) => {
          const affected = await query<{ id: string }>(
            client,
            `
              WITH RECURSIVE tree(id, path) AS (
                SELECT id, ARRAY[id] FROM tasks WHERE id = $1
                UNION ALL
                SELECT child.id, tree.path || child.id
                FROM tasks AS child JOIN tree ON child.parent_id = tree.id
                WHERE NOT (child.id = ANY(tree.path))
              )
              SELECT id FROM tree
            `,
            [taskId],
          );
          if (!expectedFence) {
            for (const row of affected) {
              await assertGenericTaskMutationSupported(client, row.id);
            }
          }
          const task = await getTask(client, taskId, true);
          if (!task) return null;
          // Identity-backed deletion re-reads every frozen fence inside this
          // transaction. A repoint, rebind, epoch bump, or locator move between
          // detection and archival makes the delete a no-op rather than a
          // silent data loss.
          if (expectedFence) {
            if (
              task.connectorType !== 'github-issues'
              || task.sourceId !== expectedFence.sourceId
            ) return null;
            const current = await captureGitHubDeletionFence(
              client,
              task.connectorInstanceId,
              task.id,
            );
            if (!sameGitHubDeletionFence(current, expectedFence)) return null;
          } else if (task.connectorType === 'github-issues') {
            throw new UnsupportedConnectorExecutionError(
              'unfenced GitHub identity-backed deletion',
            );
          }
          const tagRows = await query<{ tagId: string }>(
            client,
            'SELECT tag_id AS "tagId" FROM task_tags WHERE task_id = $1',
            [taskId],
          );
          const projectRows = await query<{ projectId: string }>(
            client,
            'SELECT project_id AS "projectId" FROM task_projects WHERE task_id = $1',
            [taskId],
          );
          const [schedule] = await query<Record<string, unknown> & QueryResultRow>(
            client,
            'SELECT * FROM task_schedules WHERE task_id = $1',
            [taskId],
          );
          const dependencies = await query<Record<string, unknown> & QueryResultRow>(
            client,
            `
              SELECT * FROM task_dependencies
              WHERE task_id = $1 OR depends_on_task_id = $1
            `,
            [taskId],
          );
          const linkedSources = await query<Record<string, unknown> & QueryResultRow>(
            client,
            'SELECT * FROM task_linked_sources WHERE task_id = $1',
            [taskId],
          );
          const linkedSourceEntities = linkedSources.length === 0
            ? []
            : await query<Record<string, unknown> & QueryResultRow>(
                client,
                `
                  SELECT * FROM task_linked_source_entities
                  WHERE linked_source_id = ANY($1::text[])
                `,
                [linkedSources.map((row) => row.id as string)],
              );
          const attachments = await query<Record<string, unknown> & QueryResultRow>(
            client,
            'SELECT * FROM task_attachments WHERE task_id = $1',
            [taskId],
          );
          const phaseItems = await query<Record<string, unknown> & QueryResultRow>(
            client,
            'SELECT * FROM project_phase_items WHERE task_id = $1',
            [taskId],
          );
          const snapshotId = randomUUID();
          const deletedAt = new Date().toISOString();
          const githubFence = task.connectorType === 'github-issues'
            ? await captureGitHubDeletionFence(client, task.connectorInstanceId, task.id)
            : null;
          await client.query(
            `
              INSERT INTO sync_deletion_snapshots (
                id, original_task_id, connector_id, source_id, task_title,
                reason, task_data, relationship_data, deleted_at,
                identity_mode, identity_mode_revision, issue_entity_id,
                repository_entity_id, host_key, locator_revision,
                binding_state, binding_revision
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14, $15, $16, $17
              )
            `,
            [
              snapshotId,
              task.id,
              task.connectorInstanceId,
              task.sourceId,
              task.title,
              reason,
              task,
              {
                tagIds: tagRows.map((row) => row.tagId),
                projectIds: projectRows.map((row) => row.projectId),
                schedule: schedule ?? null,
                dependencies,
                linkedSources,
                linkedSourceEntities,
                attachments,
                phaseItems,
              },
              deletedAt,
              githubFence?.identityMode ?? null,
              githubFence?.identityModeRevision ?? null,
              githubFence?.issueEntityId ?? null,
              githubFence?.repositoryEntityId ?? null,
              githubFence?.hostKey ?? null,
              githubFence?.locatorRevision ?? null,
              githubFence?.bindingState ?? null,
              githubFence?.bindingRevision ?? null,
            ],
          );
          await deleteTaskRows(client, taskId);
          return { snapshotId, taskTitle: task.title, sourceId: task.sourceId };
        });
      },

      async restoreDeletionSnapshot(snapshotId, mode) {
        const outcome = await transaction(pool, async (client) => {
          const [snapshot] = await query<{
            id: string;
            originalTaskId: string;
            connectorId: string;
            taskData: ConnectorTaskRecord;
            relationshipData: Record<string, unknown>;
            restoredTaskId: string | null;
            recoveryState: string;
            quarantineReason: string | null;
          }>(
            client,
            `
              SELECT
                id,
                original_task_id AS "originalTaskId",
                connector_id AS "connectorId",
                task_data AS "taskData",
                relationship_data AS "relationshipData",
                restored_task_id AS "restoredTaskId",
                recovery_state AS "recoveryState",
                quarantine_reason AS "quarantineReason"
              FROM sync_deletion_snapshots WHERE id = $1 FOR UPDATE
            `,
            [snapshotId],
          );
          if (!snapshot) throw new Error('Removed task snapshot not found');
          if (snapshot.restoredTaskId) {
            return { taskId: snapshot.restoredTaskId, alreadyRestored: true };
          }
          if (snapshot.recoveryState === 'quarantined') {
            throw new Error(
              `Removed task snapshot is quarantined: ${snapshot.quarantineReason ?? 'identity_validation_failed'}`,
            );
          }
          if (snapshot.taskData.connectorType === 'github-issues') {
            throw new UnsupportedConnectorExecutionError('GitHub identity-backed restore');
          }
          const relations = objectValue(snapshot.relationshipData);
          if (
            arrayValue(relations.dependencies).length > 0
            || arrayValue(relations.projectIds).length > 0
            || arrayValue(relations.linkedSources).length > 0
            || arrayValue(relations.phaseItems).length > 0
          ) {
            throw new UnsupportedConnectorExecutionError(
              'identity, dependency, or project relationship restore',
            );
          }
          if (await getTask(client, snapshot.originalTaskId, true)) {
            await client.query(
              `
                UPDATE sync_deletion_snapshots
                SET recovery_state = 'quarantined',
                    quarantine_reason = 'original_task_id_conflict',
                    recovery_validation = 'blocked'
                WHERE id = $1
              `,
              [snapshotId],
            );
            return { conflict: 'The original Mission Control task ID is occupied' };
          }
          const now = new Date().toISOString();
          const restoreToSource = mode === 'source';
          const archived = mapTask(snapshot.taskData);
          const parent = archived.parentId ? await getTask(client, archived.parentId) : null;
          const restoreAsSubtask = Boolean(archived.isChecklistItem && archived.parentId && parent);
          if (
            restoreToSource
            && archived.isChecklistItem
            && (
              !restoreAsSubtask
              || parent?.connectorInstanceId !== snapshot.connectorId
              || parent.sourceId.startsWith('local:')
            )
          ) {
            throw new Error('The original parent task is unavailable');
          }
          const claimToken = randomUUID();
          const claim = await client.query(
            `
              UPDATE sync_deletion_snapshots
              SET restore_mode = $1,
                  recovery_state = 'restoring',
                  recovery_claim_token = $2,
                  recovery_claimed_at = $3,
                  recovery_validation = 'verified'
              WHERE id = $4
                AND restored_task_id IS NULL
                AND recovery_state = 'pending'
            `,
            [mode, claimToken, now, snapshotId],
          );
          if (claim.rowCount !== 1) {
            throw new Error('Removed task snapshot restore could not be claimed');
          }
          const restored: ConnectorTaskRecord = {
            ...archived,
            id: snapshot.originalTaskId,
            sourceId: restoreToSource && restoreAsSubtask
              ? snapshot.originalTaskId
              : `local:${snapshot.originalTaskId}`,
            connectorType: restoreToSource ? archived.connectorType : 'local',
            connectorInstanceId: restoreToSource ? snapshot.connectorId : 'local',
            sourceListId: restoreToSource ? archived.sourceListId : null,
            sourceListName: restoreToSource ? archived.sourceListName : null,
            isChecklistItem: restoreAsSubtask,
            parentId: restoreAsSubtask ? archived.parentId : null,
            syncStatus: restoreToSource ? 'pending_push' : 'synced',
            pushRetryCount: 0,
            updatedAt: now,
            lastSyncedAt: now,
          };
          if (!(await insertTask(client, restored))) {
            throw new Error('Removed task snapshot restore could not persist the original task');
          }
          for (const tagId of arrayValue(relations.tagIds).map(String)) {
            await client.query(
              'INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)',
              [restored.id, tagId],
            );
          }
          const schedule = relations.schedule;
          if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
            const row = schedule as Record<string, unknown>;
            await client.query(
              `
                INSERT INTO task_schedules (
                  task_id, scheduled_date, scheduled_time, estimated_duration,
                  is_time_blocked, recurrence, recurrence_mode
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              `,
              [
                restored.id,
                row.scheduled_date ?? row.scheduledDate,
                row.scheduled_time ?? row.scheduledTime ?? null,
                row.estimated_duration ?? row.estimatedDuration ?? null,
                row.is_time_blocked ?? row.isTimeBlocked ?? false,
                row.recurrence ?? null,
                row.recurrence_mode ?? row.recurrenceMode ?? 'schedule',
              ],
            );
          }
          for (const value of arrayValue(relations.attachments)) {
            if (!value || typeof value !== 'object') continue;
            const row = value as Record<string, unknown>;
            await client.query(
              `
                INSERT INTO task_attachments (
                  id, task_id, name, content_type, size, content_base64,
                  source_attachment_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              `,
              [
                randomUUID(),
                restored.id,
                row.name,
                row.content_type ?? row.contentType,
                row.size,
                row.content_base64 ?? row.contentBase64 ?? null,
                row.source_attachment_id ?? row.sourceAttachmentId ?? null,
                row.created_at ?? row.createdAt,
              ],
            );
          }
          await client.query(
            `
              UPDATE sync_deletion_snapshots
              SET recovery_state = 'restored',
                  restored_at = $1,
                  restored_task_id = $2,
                  recovery_claim_token = NULL,
                  recovery_validation = 'restored_original_task_id'
              WHERE id = $3 AND recovery_claim_token = $4
            `,
            [now, restored.id, snapshotId, claimToken],
          );
          return { taskId: restored.id, alreadyRestored: false };
        });
        if ('conflict' in outcome) throw new Error(outcome.conflict);
        return outcome;
      },
    },

    notifications: {
      async ingest(commands) {
        if (commands.length === 0) return [];
        return transaction(pool, async (client) => {
          const results = [];
          for (const command of commands) {
            results.push(await ingestNotification(client, command));
          }
          return results;
        });
      },

      async listActive(connectorId) {
        return query<{
          id: string;
          sourceId: string;
          reconcileAttempts: number;
          staleSince: string | null;
        }>(
          pool,
          `
            SELECT
              id,
              source_id AS "sourceId",
              reconcile_attempts AS "reconcileAttempts",
              stale_since AS "staleSince"
            FROM notifications
            WHERE connector_instance_id = $1
              AND source_state IN ('active', 'unknown')
              AND (template_key IS NULL OR template_key <> 'workflow_result')
          `,
          [connectorId],
        );
      },

      async applyReconciliation(input) {
        return transaction(pool, async (client) => {
          let resolved = 0;
          for (const outcome of input.outcomes) {
            if (outcome.resolved) {
              const result = await client.query(
                `
                  UPDATE notifications
                  SET state = CASE
                        WHEN disposition = 'dismissed' THEN 'dismissed'
                        ELSE 'resolved'
                      END,
                      source_state = 'resolved',
                      resolved_at = $1,
                      source_resolved_at = $1,
                      last_reconciled_at = $2,
                      reconcile_attempts = 0,
                      stale_since = NULL,
                      auto_resolve_reason = $3
                  WHERE id = $4
                `,
                [
                  outcome.resolvedAt ?? input.now,
                  input.now,
                  outcome.reason ?? 'handled_upstream',
                  outcome.notificationId,
                ],
              );
              resolved += result.rowCount ?? 0;
            } else {
              await client.query(
                `
                  UPDATE notifications
                  SET last_reconciled_at = $1, reconcile_attempts = 0, stale_since = NULL
                  WHERE id = $2
                `,
                [input.now, outcome.notificationId],
              );
            }
          }
          return resolved;
        });
      },

      async recordReconciliationFailure(input) {
        if (input.notificationIds.length === 0) return;
        await pool.query(
          `
            UPDATE notifications
            SET reconcile_attempts = reconcile_attempts + 1,
                stale_since = COALESCE(stale_since, $1)
            WHERE id = ANY($2::text[])
          `,
          [input.now, input.notificationIds],
        );
      },

      async archiveStale(input) {
        const result = await pool.query(
          `
            UPDATE notifications
            SET state = CASE
                  WHEN disposition = 'dismissed' THEN 'dismissed'
                  ELSE 'archived'
                END,
                disposition = CASE
                  WHEN disposition = 'dismissed' THEN 'dismissed'
                  ELSE 'handled'
                END,
                source_state = 'unknown',
                handled_at = CASE
                  WHEN disposition = 'dismissed' THEN handled_at
                  ELSE $1
                END,
                handled_source_activity_at = CASE
                  WHEN disposition = 'dismissed' THEN handled_source_activity_at
                  ELSE last_source_activity_at
                END,
                handled_source_activity_key = CASE
                  WHEN disposition = 'dismissed' THEN handled_source_activity_key
                  ELSE last_source_activity_key
                END,
                archived_at = CASE
                  WHEN disposition = 'dismissed' THEN archived_at
                  ELSE $1
                END,
                auto_resolve_reason = 'stale_unverifiable'
            WHERE connector_instance_id = $2
              AND source_state IN ('active', 'unknown')
              AND (template_key IS NULL OR template_key <> 'workflow_result')
              AND stale_since IS NOT NULL
              AND stale_since < $3
              AND reconcile_attempts >= $4
          `,
          [input.now, input.connectorId, input.cutoff, input.minimumAttempts],
        );
        return result.rowCount ?? 0;
      },

      async mergeMetadata(notificationId, metadata) {
        return transaction(pool, async (client) => {
          const [row] = await query<{ metadata: unknown }>(
            client,
            'SELECT metadata FROM notifications WHERE id = $1 FOR UPDATE',
            [notificationId],
          );
          if (!row) return false;
          await client.query(
            'UPDATE notifications SET metadata = $1 WHERE id = $2',
            [{ ...objectValue(row.metadata), ...metadata }, notificationId],
          );
          return true;
        });
      },
    },

    conflicts: {
      async applyResolution(command) {
        await transaction(pool, async (client) => {
          const task = await getTask(client, command.taskId, true);
          if (!task) throw new Error(`Task ${command.taskId} was not found`);
          if (task.connectorType === 'github-issues') {
            throw new UnsupportedConnectorExecutionError('GitHub identity-backed conflict mutation');
          }
          const changed = await updateTask(client, command.taskId, {
            ...command.winningVersion,
            updatedAt: command.resolvedAt,
            syncStatus: 'synced',
            lastSyncedAt: command.resolvedAt,
          });
          if (changed !== 1) throw new Error(`Task ${command.taskId} changed during conflict resolution`);
          await client.query(
            `
              INSERT INTO sync_log (
                id, connector_id, success, tasks_added, tasks_updated,
                tasks_removed, tasks_pushed, local_only_protected, alerts_added,
                errors, details, synced_at
              ) VALUES ($1, $2, true, 0, 1, 0, 0, 0, 0, $3, '[]'::jsonb, $4)
            `,
            [
              randomUUID(),
              command.connectorId,
              JSON.stringify([{
                type: 'conflict_resolved',
                taskId: command.taskId,
                resolution: command.resolution,
                localUpdatedAt: command.localUpdatedAt,
                remoteUpdatedAt: command.remoteUpdatedAt,
              }]),
              command.resolvedAt,
            ],
          );
        });
      },

      async listUnresolved() {
        return (await query<ConnectorTaskRecord>(
          pool,
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE sync_status = 'conflict'`,
        )).map(mapTask);
      },
    },

    retention: {
      async getDetail(syncLogId, detailIndex) {
        return loadRetentionRecord(pool, syncLogId, detailIndex);
      },

      async claim(input) {
        return transaction(pool, async (client) => {
          const record = await loadRetentionRecord(
            client,
            input.syncLogId,
            input.detailIndex,
            true,
          );
          if (!record) return { status: 'not-found' as const };
          const current = record.detail.resolution;
          let recoveringStaleClaim = false;
          if (
            current?.status === 'succeeded'
            || (current?.status === 'indeterminate' && input.action === 'retry_push')
          ) {
            return { status: 'unchanged' as const, record };
          }
          if (current?.status === 'in_progress') {
            const expiresAt = current.leaseExpiresAt
              ?? new Date(Date.parse(current.resolvedAt) + 5 * 60_000).toISOString();
            if (Date.parse(expiresAt) > Date.parse(input.now)) {
              return { status: 'unchanged' as const, record };
            }
            recoveringStaleClaim = true;
          }
          const detail = {
            ...record.detail,
            resolution: {
              action: input.action,
              status: 'in_progress',
              resolvedAt: input.now,
              message: 'Resolution is in progress.',
              claimId: input.claimId,
              leaseExpiresAt: input.leaseExpiresAt,
            },
          };
          await writeRetentionDetail(client, input.syncLogId, input.detailIndex, detail);
          return {
            status: 'claimed' as const,
            record: { ...record, detail },
            recoveringStaleClaim,
          };
        });
      },

      async renew(input) {
        return transaction(pool, async (client) => {
          const record = await loadRetentionRecord(
            client,
            input.syncLogId,
            input.detailIndex,
            true,
          );
          if (
            record?.detail.resolution?.status !== 'in_progress'
            || record.detail.resolution.claimId !== input.claimId
          ) return false;
          await writeRetentionDetail(client, input.syncLogId, input.detailIndex, {
            ...record.detail,
            resolution: {
              ...record.detail.resolution,
              leaseExpiresAt: input.leaseExpiresAt,
            },
          });
          return true;
        });
      },

      async finalize(input) {
        return transaction(pool, async (client) => {
          const record = await loadRetentionRecord(
            client,
            input.syncLogId,
            input.detailIndex,
            true,
          );
          if (
            record?.detail.resolution?.status !== 'in_progress'
            || record.detail.resolution.claimId !== input.claimId
          ) return false;
          await writeRetentionDetail(client, input.syncLogId, input.detailIndex, {
            ...record.detail,
            resolution: input.resolution,
          });
          return true;
        });
      },

      async findTask(input) {
        if (input.taskId) {
          const task = await getTask(pool, input.taskId);
          if (
            task?.connectorInstanceId === input.connectorId
            && task.sourceId === input.taskSourceId
          ) return task;
        }
        const [row] = await query<ConnectorTaskRecord>(
          pool,
          `
            SELECT ${TASK_COLUMNS} FROM tasks
            WHERE connector_instance_id = $1 AND source_id = $2
            LIMIT 1
          `,
          [input.connectorId, input.taskSourceId],
        );
        return row ? mapTask(row) : null;
      },

      async getTask(taskId) {
        return getTask(pool, taskId);
      },

      async convertTaskTreeToLocal(taskId, archive) {
        await transaction(pool, async (client) => {
          await assertGenericTaskMutationSupported(client, taskId);
          const now = new Date().toISOString();
          const ids = await query<{ id: string }>(
            client,
            `
              WITH RECURSIVE tree(id, path) AS (
                SELECT id, ARRAY[id] FROM tasks WHERE id = $1
                UNION ALL
                SELECT child.id, tree.path || child.id
                FROM tasks AS child JOIN tree ON child.parent_id = tree.id
                WHERE NOT (child.id = ANY(tree.path))
              )
              SELECT id FROM tree
            `,
            [taskId],
          );
          const tasks: ConnectorTaskRecord[] = [];
          for (const { id } of ids) {
            const task = await getTask(client, id, true);
            if (!task) continue;
            await assertGenericTaskMutationSupported(client, task.id);
            tasks.push(task);
          }
          for (const task of tasks) {
            await updateTask(client, task.id, {
              sourceId: `local:${task.id}`,
              connectorType: 'local',
              connectorInstanceId: 'local',
              sourceListId: null,
              sourceListName: null,
              syncStatus: 'synced',
              pushRetryCount: 0,
              updatedAt: now,
              lastSyncedAt: now,
              metadata: {
                ...task.metadata,
                retentionResolution: {
                  action: archive ? 'archive_local' : 'keep_local',
                  resolvedAt: now,
                  previousConnectorType: task.connectorType,
                  previousConnectorInstanceId: task.connectorInstanceId,
                  previousSourceId: task.sourceId,
                },
              },
            });
          }
        });
      },

      async deleteTaskTree(taskId) {
        await transaction(pool, async (client) => {
          const ids = await query<{ id: string; depth: number }>(
            client,
            `
              WITH RECURSIVE tree(id, depth, path) AS (
                SELECT id, 0, ARRAY[id] FROM tasks WHERE id = $1
                UNION ALL
                SELECT child.id, tree.depth + 1, tree.path || child.id
                FROM tasks child JOIN tree ON child.parent_id = tree.id
                WHERE NOT (child.id = ANY(tree.path))
              )
              SELECT id, depth FROM tree ORDER BY depth DESC
            `,
            [taskId],
          );
          for (const task of ids) {
            await assertGenericTaskMutationSupported(client, task.id);
          }
          for (const task of ids) await deleteTaskRows(client, task.id);
        });
      },
    },

    support: {
      allowsLegacyWorkflow(workflow) {
        // Layer 3A migrated GitHub dependency reconciliation, and Layer 6A
        // migrated notification delivery including both default senders.
        return workflow === 'dependency-reconciliation'
          || workflow === 'notification-dispatcher';
      },
      assertConfigSupported(config: ConnectorConfig) {
        // Layer 4 migrated Microsoft To Do hidden-list discovery and the whole
        // Work To Do bridge (ingest/pull/lease/ack/status/reset) behind the
        // portable execution and `connectorState.workTodo` ports, so both are
        // now supported. Layer 5C also composes finance domain state behind
        // FinanceWorkerPersistence without enabling unrelated legacy workflows.
        if (
          config.type !== 'github-issues'
          && (config.capabilities.dependencyRead || config.capabilities.dependencyWrite)
        ) {
          throw new UnsupportedConnectorExecutionError('connector dependency state');
        }
      },

      assertConnectorSupported(connector) {
        if (
          connector.syncDomainData
          && !normalizeFinanceProviderAlias(connector.type)
        ) {
          throw new UnsupportedConnectorExecutionError('connector-owned domain state');
        }
        if (connector.type === 'github-issues') return;
        if (connector.dependencySnapshotStrategy) {
          throw new UnsupportedConnectorExecutionError('connector dependency state');
        }
        if (connector.fetchProjectAssociations) {
          throw new UnsupportedConnectorExecutionError('connector project state');
        }
      },

      async listEnabledConnectorIds() {
        return (await query<{ id: string }>(
          pool,
          `
            SELECT id FROM connector_configs
            WHERE enabled = true AND deleted_at IS NULL
          `,
        )).map((row) => row.id);
      },

      async listEnabledGitHubConfigs() {
        return (await query<{ id: string; type: string; capabilities: unknown }>(
          pool,
          `
            SELECT id, type, capabilities
            FROM connector_configs
            WHERE enabled = true AND deleted_at IS NULL AND type = 'github-issues'
          `,
        )).map((row) => ({
          id: row.id,
          type: row.type,
          capabilities: objectValue(row.capabilities) as unknown as ConnectorConfig['capabilities'],
        }));
      },

      async listConnectorTaskIdentities(connectorId) {
        return query<{ id: string; sourceId: string }>(
          pool,
          'SELECT id, source_id AS "sourceId" FROM tasks WHERE connector_instance_id = $1',
          [connectorId],
        );
      },

      async listConnectorTaskIds(connectorId, sourceIds) {
        const rows = await query<{ id: string; sourceId: string }>(
          pool,
          'SELECT id, source_id AS "sourceId" FROM tasks WHERE connector_instance_id = $1',
          [connectorId],
        );
        return rows.filter((row) => !sourceIds || sourceIds.has(row.sourceId))
          .map((row) => row.id);
      },
    },
  };
}
