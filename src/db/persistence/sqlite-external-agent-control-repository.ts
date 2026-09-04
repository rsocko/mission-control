import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import type {
  AgentDispatchDetail,
  AgentDispatchRecord,
  AgentDispatchStatus,
  AgentPayloadSnapshot,
  ExternalAgentRecord,
} from '@/lib/external-agents/contracts';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import type {
  DispatchEventInput,
  DispatchFinalizeInput,
  DispatchResultPersistenceInput,
  ExternalAgentControlPersistence,
  ExternalAgentCreateRecord,
  ExternalAgentUpdateRecord,
} from './external-agent-control';

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

const TERMINAL = new Set<AgentDispatchStatus>([
  'completed', 'failed', 'timed_out', 'dead_letter', 'cancelled',
]);
const ACTIVE_RESULT = new Set<AgentDispatchStatus>([
  'queued', 'claimed', 'in_progress', 'waiting_for_user',
]);

const AGENT_COLUMNS = `
  id, name, type, transport, execution_locality AS executionLocality,
  description, endpoint, auth_type AS authType,
  auth_credential_ref AS authCredentialRef, capabilities,
  input_format AS inputFormat, output_format AS outputFormat,
  inbound_webhook_id AS inboundWebhookId, data_policy AS dataPolicy,
  enabled, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt
`;

const DISPATCH_COLUMNS = `
  id, external_agent_id AS externalAgentId, idempotency_key AS idempotencyKey,
  instruction, scope, status, transport, execution_locality AS executionLocality,
  data_classification AS dataClassification, allowed_actions AS allowedActions,
  disclosed_fields AS disclosedFields, payload_preview AS payloadPreview,
  preview_hash AS previewHash, provider_task_id AS providerTaskId,
  provider_detail AS providerDetail, result, result_digest AS resultDigest,
  result_status AS resultStatus, claim_token_hash AS claimTokenHash,
  claimed_at AS claimedAt, lease_expires_at AS leaseExpiresAt,
  attempt_count AS attemptCount, max_attempts AS maxAttempts,
  available_at AS availableAt, deadline_at AS deadlineAt,
  cancel_requested_at AS cancelRequestedAt, github_issue_url AS githubIssueUrl,
  github_pull_request_url AS githubPullRequestUrl, repository,
  base_ref AS baseRef, branch_ref AS branchRef, commit_sha AS commitSha,
  checks, artifacts, error_message AS errorMessage, confirmed_at AS confirmedAt,
  started_at AS startedAt, completed_at AS completedAt,
  reviewed_at AS reviewedAt, created_at AS createdAt, updated_at AS updatedAt
`;

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  return JSON.parse(value) as T;
}

function agentFromRow(row: Row): ExternalAgentRecord {
  return {
    ...(row as unknown as ExternalAgentRecord),
    enabled: Boolean(row.enabled),
    capabilities: json(row.capabilities, {}),
    dataPolicy: json(row.dataPolicy, {
      allowedClassifications: [],
      fieldAllowlist: [],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    }),
  };
}

function dispatchFromRow(row: Row): AgentDispatchRecord {
  return {
    ...(row as unknown as AgentDispatchRecord),
    scope: json(row.scope, {}),
    allowedActions: json(row.allowedActions, []),
    disclosedFields: json(row.disclosedFields, []),
    payloadPreview: json(row.payloadPreview, {}),
    providerDetail: json(row.providerDetail, null),
    result: json(row.result, null),
    checks: json(row.checks, null),
    artifacts: json(row.artifacts, null),
  };
}

function assertProtectedInboundWebhook(sqlite: Database.Database, id: string | null): void {
  if (!id) return;
  const webhook = sqlite.prepare(
    'SELECT enabled, secret FROM inbound_webhooks WHERE id = ?',
  ).get(id) as { enabled: number; secret: string | null } | undefined;
  if (!webhook) {
    throw new ExternalAgentError('Inbound webhook not found', 'VALIDATION_ERROR', 422);
  }
  if (!webhook.enabled || !webhook.secret) {
    throw new ExternalAgentError(
      'Agent result webhooks must be enabled and HMAC-protected',
      'VALIDATION_ERROR',
      422,
    );
  }
}

function insertEvent(
  sqlite: Database.Database,
  dispatchId: string,
  input: DispatchEventInput,
): void {
  sqlite.prepare(`
    INSERT INTO agent_dispatch_events (
      dispatch_id, event_type, from_status, to_status, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    dispatchId,
    input.eventType,
    input.fromStatus,
    input.toStatus,
    JSON.stringify(input.detail),
    input.createdAt,
  );
}

function state(sqlite: Database.Database, id: string): AgentDispatchRecord | null {
  const row = sqlite.prepare(`SELECT ${DISPATCH_COLUMNS} FROM agent_dispatches WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? dispatchFromRow(row) : null;
}

function equalHash(actual: string | undefined, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function destinationMatches(
  current: ExternalAgentRecord | undefined,
  expected: Parameters<
    ExternalAgentControlPersistence['dispatches']['confirm']
  >[0]['agentSnapshot'],
): boolean {
  return Boolean(
    current
    && current.type === expected.type
    && current.transport === expected.transport
    && current.executionLocality === expected.executionLocality
    && current.endpoint === expected.endpoint
    && current.authType === expected.authType
    && current.authCredentialRef === expected.authCredentialRef
    && current.inboundWebhookId === expected.inboundWebhookId
    && canonical(current.capabilities) === canonical(expected.capabilities)
    && canonical(current.dataPolicy) === canonical(expected.dataPolicy)
    && current.enabled === expected.enabled
    && current.deletedAt === expected.deletedAt
  );
}

function rateLimit(
  sqlite: Database.Database,
  agentId: string,
  maximum: number,
  now: string,
): void {
  const since = new Date(new Date(now).getTime() - 60_000).toISOString();
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_dispatch_events
    WHERE event_type IN ('dispatch_confirmed', 'retry_requested')
      AND created_at >= ?
      AND dispatch_id IN (
        SELECT id FROM agent_dispatches WHERE external_agent_id = ?
      )
  `).get(since, agentId) as { count: number };
  if (row.count >= maximum) {
    throw new ExternalAgentError(
      'External-agent rate limit exceeded',
      'RATE_LIMITED',
      429,
    );
  }
}

function expireOne(
  sqlite: Database.Database,
  dispatch: Pick<AgentDispatchRecord, 'id' | 'status' | 'attemptCount'>,
  now: string,
): void {
  const updated = sqlite.prepare(`
    UPDATE agent_dispatches
    SET status = 'timed_out', completed_at = ?, updated_at = ?,
        claim_token_hash = NULL, lease_expires_at = NULL,
        error_message = 'Dispatch exceeded its deadline'
    WHERE id = ? AND status = ?
  `).run(now, now, dispatch.id, dispatch.status);
  if (updated.changes !== 1) {
    throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
  }
  sqlite.prepare(`
    UPDATE agent_dispatch_attempts
    SET status = 'timed_out', error_message = 'Dispatch exceeded its deadline',
        completed_at = ?
    WHERE dispatch_id = ? AND attempt_number = ? AND completed_at IS NULL
  `).run(now, dispatch.id, dispatch.attemptCount);
  insertEvent(sqlite, dispatch.id, {
    eventType: 'timed_out',
    fromStatus: dispatch.status,
    toStatus: 'timed_out',
    detail: {},
    createdAt: now,
  });
}

function recoverClaims(sqlite: Database.Database, now: string, agentId?: string): void {
  const rows = sqlite.prepare(`
    SELECT id, status, attempt_count AS attemptCount, max_attempts AS maxAttempts
    FROM agent_dispatches
    WHERE transport = 'pull'
      AND status IN ('claimed', 'in_progress', 'waiting_for_user')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
      ${agentId ? 'AND external_agent_id = ?' : ''}
  `).all(...(agentId ? [now, agentId] : [now])) as Array<{
    id: string;
    status: AgentDispatchStatus;
    attemptCount: number;
    maxAttempts: number;
  }>;
  for (const row of rows) {
    const next: AgentDispatchStatus = row.attemptCount >= row.maxAttempts
      ? 'dead_letter'
      : 'queued';
    const updated = sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = ?, available_at = ?, claim_token_hash = NULL, claimed_at = NULL,
          lease_expires_at = NULL,
          completed_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE NULL END,
          error_message = 'Claim lease expired', updated_at = ?
      WHERE id = ? AND status = ?
    `).run(next, now, next, now, now, row.id, row.status);
    if (updated.changes !== 1) continue;
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts
      SET status = 'lease_expired', error_message = 'Claim lease expired', completed_at = ?
      WHERE dispatch_id = ? AND attempt_number = ?
    `).run(now, row.id, row.attemptCount);
    insertEvent(sqlite, row.id, {
      eventType: 'claim_expired',
      fromStatus: row.status,
      toStatus: next,
      detail: { attempt: row.attemptCount },
      createdAt: now,
    });
  }
}

function agentValues(record: ExternalAgentCreateRecord | ExternalAgentUpdateRecord): SqlValue[] {
  return [
    record.name,
    record.type,
    record.transport,
    record.executionLocality,
    record.description,
    record.endpoint,
    record.authType,
    record.authCredentialRef,
    JSON.stringify(record.capabilities),
    record.inputFormat,
    record.outputFormat,
    record.inboundWebhookId,
    JSON.stringify(record.dataPolicy),
    record.enabled ? 1 : 0,
    record.updatedAt,
    record.deletedAt,
  ];
}

export function createSqliteExternalAgentControlRepository(
  sqlite: Database.Database,
): ExternalAgentControlPersistence {
  const registry: ExternalAgentControlPersistence['registry'] = {
    async list(options = {}) {
      const rows = sqlite.prepare(`
        SELECT ${AGENT_COLUMNS} FROM external_agents
        ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
        ORDER BY created_at ASC, id ASC
      `).all() as Row[];
      return rows.map(agentFromRow);
    },
    async get(id, includeDeleted = false) {
      const row = sqlite.prepare(`
        SELECT ${AGENT_COLUMNS} FROM external_agents
        WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      `).get(id) as Row | undefined;
      return row ? agentFromRow(row) : null;
    },
    async create(record) {
      sqlite.transaction(() => {
        assertProtectedInboundWebhook(sqlite, record.inboundWebhookId);
        sqlite.prepare(`
          INSERT INTO external_agents (
            id, name, type, transport, execution_locality, description, endpoint,
            auth_type, auth_credential_ref, capabilities, input_format, output_format,
            inbound_webhook_id, data_policy, enabled, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(record.id, ...agentValues(record).slice(0, 14), record.createdAt,
          record.updatedAt, record.deletedAt);
      }).immediate();
      return (await registry.get(record.id, true))!;
    },
    async update(id, record) {
      sqlite.transaction(() => {
        assertProtectedInboundWebhook(sqlite, record.inboundWebhookId);
        sqlite.prepare(`
          UPDATE external_agents SET
            name = ?, type = ?, transport = ?, execution_locality = ?,
            description = ?, endpoint = ?, auth_type = ?, auth_credential_ref = ?,
            capabilities = ?, input_format = ?, output_format = ?,
            inbound_webhook_id = ?, data_policy = ?, enabled = ?,
            updated_at = ?, deleted_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(...agentValues(record), id);
      }).immediate();
      return registry.get(id);
    },
    async softDelete(id, now) {
      const result = sqlite.prepare(`
        UPDATE external_agents
        SET enabled = 0, deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      return result.changes === 1;
    },
  };

  const payloads: ExternalAgentControlPersistence['payloads'] = {
    async snapshot(scope) {
      return sqlite.transaction(() => {
        const project = scope.projectId
        ? sqlite.prepare(`
            SELECT id, name, description FROM hub_projects WHERE id = ?
          `).get(scope.projectId) as AgentPayloadSnapshot['project'] | undefined
        : undefined;
      const ids = new Set(scope.taskIds ?? []);
      if (scope.projectId) {
        const memberships = sqlite.prepare(`
          SELECT task_id AS taskId FROM task_projects
          WHERE project_id = ? ORDER BY task_id
        `).all(scope.projectId) as Array<{ taskId: string }>;
        memberships.forEach(({ taskId }) => ids.add(taskId));
      }
      const taskRows = ids.size
        ? sqlite.prepare(`
            SELECT id, title, description, priority, status,
                   connector_type AS connectorType
            FROM tasks WHERE id IN (${[...ids].map(() => '?').join(', ')})
            ORDER BY id
          `).all(...ids) as AgentPayloadSnapshot['tasks']
        : [];
      const tagsByTask = new Map<string, string[]>();
      if (taskRows.length) {
        const tagRows = sqlite.prepare(`
          SELECT tt.task_id AS taskId, t.name
          FROM task_tags tt INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id IN (${taskRows.map(() => '?').join(', ')})
          ORDER BY tt.task_id, t.name
        `).all(...taskRows.map(({ id }) => id)) as Array<{ taskId: string; name: string }>;
        for (const row of tagRows) {
          tagsByTask.set(row.taskId, [...(tagsByTask.get(row.taskId) ?? []), row.name]);
        }
      }
      const phaseRows = scope.projectId
        ? sqlite.prepare(`
            SELECT id, name, description, sort_order AS sortOrder
            FROM project_phases WHERE project_id = ?
            ORDER BY sort_order, id
          `).all(scope.projectId) as Array<{
            id: string;
            name: string;
            description: string | null;
            sortOrder: number;
          }>
        : [];
      const itemsByPhase = new Map<string, string[]>();
      if (phaseRows.length) {
        const rows = sqlite.prepare(`
          SELECT phase_id AS phaseId, task_id AS taskId
          FROM project_phase_items
          WHERE phase_id IN (${phaseRows.map(() => '?').join(', ')})
          ORDER BY phase_id, sort_order, task_id
        `).all(...phaseRows.map(({ id }) => id)) as Array<{ phaseId: string; taskId: string }>;
        for (const row of rows) {
          itemsByPhase.set(row.phaseId, [...(itemsByPhase.get(row.phaseId) ?? []), row.taskId]);
        }
      }
        return {
          project,
          tasks: taskRows.map((task) => ({ ...task, tags: tagsByTask.get(task.id) ?? [] })),
          phases: phaseRows.map(({ id, ...phase }) => ({
            ...phase,
            taskIds: itemsByPhase.get(id) ?? [],
          })),
        };
      }).deferred();
    },
  };

  const dispatches: ExternalAgentControlPersistence['dispatches'] = {
    async get(id): Promise<AgentDispatchDetail | null> {
      const dispatch = state(sqlite, id);
      if (!dispatch) return null;
      const attempts = (sqlite.prepare(`
        SELECT id, dispatch_id AS dispatchId, attempt_number AS attemptNumber,
               status, provider_task_id AS providerTaskId,
               provider_detail AS providerDetail, error_message AS errorMessage,
               started_at AS startedAt, completed_at AS completedAt
        FROM agent_dispatch_attempts WHERE dispatch_id = ?
        ORDER BY attempt_number
      `).all(id) as Row[]).map((row) => ({
        ...(row as unknown as AgentDispatchDetail['attempts'][number]),
        providerDetail: json(row.providerDetail, null),
      }));
      const events = (sqlite.prepare(`
        SELECT id, dispatch_id AS dispatchId, event_type AS eventType,
               from_status AS fromStatus, to_status AS toStatus, detail,
               created_at AS createdAt
        FROM agent_dispatch_events WHERE dispatch_id = ? ORDER BY id
      `).all(id) as Row[]).map((row) => ({
        ...(row as unknown as AgentDispatchDetail['events'][number]),
        detail: json(row.detail, {}),
      }));
      return { ...dispatch, attempts, events };
    },
    async list(options = {}) {
      const predicates: string[] = [];
      const values: SqlValue[] = [];
      if (options.status) {
        predicates.push('status = ?');
        values.push(options.status);
      }
      if (options.agentId) {
        predicates.push('external_agent_id = ?');
        values.push(options.agentId);
      }
      values.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
      const rows = sqlite.prepare(`
        SELECT ${DISPATCH_COLUMNS} FROM agent_dispatches
        ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT ?
      `).all(...values) as Row[];
      return rows.map(dispatchFromRow);
    },
    async findPreview(agentId, idempotencyKey) {
      return (sqlite.prepare(`
        SELECT id, preview_hash AS previewHash FROM agent_dispatches
        WHERE external_agent_id = ? AND idempotency_key = ?
      `).get(agentId, idempotencyKey) as { id: string; previewHash: string } | undefined) ?? null;
    },
    async createPreview(record, createdEvent) {
      return sqlite.transaction(() => {
        const duplicate = sqlite.prepare(`
          SELECT id, preview_hash AS previewHash FROM agent_dispatches
          WHERE external_agent_id = ? AND idempotency_key = ?
        `).get(record.externalAgentId, record.idempotencyKey) as
          { id: string; previewHash: string } | undefined;
        if (duplicate) {
          if (duplicate.previewHash !== record.previewHash) {
            throw new ExternalAgentError(
              'Idempotency key was already used for a different disclosure preview',
              'IDEMPOTENCY_CONFLICT',
              409,
            );
          }
          return { ...duplicate, created: false };
        }
        sqlite.prepare(`
          INSERT INTO agent_dispatches (
            id, external_agent_id, idempotency_key, instruction, scope, status,
            transport, execution_locality, data_classification, allowed_actions,
            disclosed_fields, payload_preview, preview_hash, provider_task_id,
            provider_detail, result, result_digest, result_status, claim_token_hash,
            claimed_at, lease_expires_at, attempt_count, max_attempts, available_at,
            deadline_at, cancel_requested_at, github_issue_url, github_pull_request_url,
            repository, base_ref, branch_ref, commit_sha, checks, artifacts,
            error_message, confirmed_at, started_at, completed_at, reviewed_at,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          record.id, record.externalAgentId, record.idempotencyKey, record.instruction,
          JSON.stringify(record.scope), record.status, record.transport,
          record.executionLocality, record.dataClassification,
          JSON.stringify(record.allowedActions), JSON.stringify(record.disclosedFields),
          JSON.stringify(record.payloadPreview), record.previewHash, record.providerTaskId,
          record.providerDetail ? JSON.stringify(record.providerDetail) : null,
          record.result ? JSON.stringify(record.result) : null, record.resultDigest,
          record.resultStatus, record.claimTokenHash, record.claimedAt,
          record.leaseExpiresAt, record.attemptCount, record.maxAttempts,
          record.availableAt, record.deadlineAt, record.cancelRequestedAt,
          record.githubIssueUrl, record.githubPullRequestUrl, record.repository,
          record.baseRef, record.branchRef, record.commitSha,
          record.checks ? JSON.stringify(record.checks) : null,
          record.artifacts ? JSON.stringify(record.artifacts) : null,
          record.errorMessage, record.confirmedAt, record.startedAt, record.completedAt,
          record.reviewedAt, record.createdAt, record.updatedAt,
        );
        insertEvent(sqlite, record.id, createdEvent);
        return { id: record.id, previewHash: record.previewHash, created: true };
      }).immediate();
    },
    async confirm(input) {
      return sqlite.transaction(() => {
        const current = state(sqlite, input.id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.externalAgentId !== input.agentId) {
          throw new ExternalAgentError('Dispatch agent changed unexpectedly', 'CONFLICT', 409);
        }
        const destinationRow = sqlite.prepare(`
          SELECT ${AGENT_COLUMNS} FROM external_agents WHERE id = ?
        `).get(input.agentId) as Row | undefined;
        const destination = destinationRow ? agentFromRow(destinationRow) : undefined;
        if (
          current.previewHash !== input.previewHash
          || input.currentPreviewHash !== input.previewHash
          || !destinationMatches(destination, input.agentSnapshot)
        ) {
          throw new ExternalAgentError(
            'Disclosure preview changed; preview again before confirmation',
            'PREVIEW_MISMATCH',
            409,
          );
        }
        if (current.status !== 'needs_confirmation') return false;
        rateLimit(sqlite, input.agentId, input.maxRequestsPerMinute, input.now);
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET status = 'queued', confirmed_at = ?, available_at = ?, updated_at = ?
          WHERE id = ? AND status = 'needs_confirmation' AND preview_hash = ?
        `).run(input.now, input.now, input.now, input.id, input.previewHash);
        if (updated.changes !== 1) return false;
        insertEvent(sqlite, input.id, {
          eventType: 'dispatch_confirmed',
          fromStatus: 'needs_confirmation',
          toStatus: 'queued',
          detail: {
            previewHash: input.previewHash,
            executionLocality: current.executionLocality,
          },
          createdAt: input.now,
        });
        return true;
      }).immediate();
    },
    async beginAttempt(input) {
      return sqlite.transaction(() => {
        const current = state(sqlite, input.id);
        if (!current || current.status !== 'queued') return null;
        const attempt = current.attemptCount + 1;
        if (attempt > current.maxAttempts) {
          sqlite.prepare(`
            UPDATE agent_dispatches
            SET status = 'dead_letter', completed_at = ?, updated_at = ?,
                error_message = 'Maximum dispatch attempts exceeded'
            WHERE id = ? AND status = 'queued'
          `).run(input.now, input.now, input.id);
          insertEvent(sqlite, input.id, {
            eventType: 'attempts_exhausted',
            fromStatus: 'queued',
            toStatus: 'dead_letter',
            detail: { attempt },
            createdAt: input.now,
          });
          return null;
        }
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET status = 'in_progress', attempt_count = ?,
              started_at = COALESCE(started_at, ?), lease_expires_at = ?,
              updated_at = ?, error_message = NULL
          WHERE id = ? AND status = 'queued'
        `).run(attempt, input.now, input.leaseExpiresAt, input.now, input.id);
        if (updated.changes !== 1) return null;
        sqlite.prepare(`
          INSERT INTO agent_dispatch_attempts (
            id, dispatch_id, attempt_number, status, started_at
          ) VALUES (?, ?, ?, 'in_progress', ?)
        `).run(input.attemptId, input.id, attempt, input.now);
        insertEvent(sqlite, input.id, {
          eventType: 'attempt_started',
          fromStatus: 'queued',
          toStatus: 'in_progress',
          detail: { attempt },
          createdAt: input.now,
        });
        return { attempt, leaseExpiresAt: input.leaseExpiresAt, payload: current.payloadPreview };
      }).immediate();
    },
    async resumeAttempt(input) {
      return sqlite.transaction(() => {
        const current = state(sqlite, input.id);
        if (
          !current
          || current.status !== 'in_progress'
          || current.providerTaskId
          || !current.leaseExpiresAt
          || current.leaseExpiresAt > input.now
        ) return null;
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'in_progress' AND provider_task_id IS NULL
            AND lease_expires_at <= ?
        `).run(input.leaseExpiresAt, input.now, input.id, input.now);
        if (updated.changes !== 1) return null;
        insertEvent(sqlite, input.id, {
          eventType: 'attempt_recovered',
          fromStatus: 'in_progress',
          toStatus: 'in_progress',
          detail: { attempt: current.attemptCount, leaseExpiresAt: input.leaseExpiresAt },
          createdAt: input.now,
        });
        return {
          attempt: current.attemptCount,
          leaseExpiresAt: input.leaseExpiresAt,
          payload: current.payloadPreview,
        };
      }).immediate();
    },
    async finalizeAttempt(input: DispatchFinalizeInput) {
      return sqlite.transaction(() => {
        const current = state(sqlite, input.dispatchId);
        if (
          !current
          || current.status !== 'in_progress'
          || current.attemptCount !== input.attempt
          || current.leaseExpiresAt !== input.leaseExpiresAt
          || (
            current.providerTaskId !== null
            && current.providerTaskId !== (input.providerTaskId ?? null)
          )
        ) return 'stale' as const;
        if (current.deadlineAt && current.deadlineAt <= input.now) {
          expireOne(sqlite, current, input.now);
          return 'expired' as const;
        }
        const terminal = input.status === 'completed' || input.status === 'failed';
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches SET
            status = ?, provider_task_id = COALESCE(?, provider_task_id),
            provider_detail = ?, result = ?, result_digest = ?, result_status = ?,
            error_message = ?, github_pull_request_url = ?,
            repository = COALESCE(?, repository), base_ref = COALESCE(?, base_ref),
            branch_ref = ?, commit_sha = ?, checks = ?, artifacts = ?,
            lease_expires_at = NULL,
            completed_at = CASE WHEN ? THEN ? ELSE NULL END, updated_at = ?
          WHERE id = ? AND status = 'in_progress' AND attempt_count = ?
            AND lease_expires_at = ?
            AND (provider_task_id IS NULL OR provider_task_id = ?)
        `).run(
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.result ? JSON.stringify(input.result) : null,
          input.resultDigest, input.resultStatus, input.errorMessage,
          input.pullRequestUrl, input.repository, input.baseRef, input.branchRef,
          input.commitSha, input.checks ? JSON.stringify(input.checks) : null,
          input.artifacts ? JSON.stringify(input.artifacts) : null,
          terminal ? 1 : 0, input.now, input.now, input.dispatchId, input.attempt,
          input.leaseExpiresAt,
          input.providerTaskId ?? null,
        );
        if (updated.changes !== 1) return 'stale' as const;
        sqlite.prepare(`
          UPDATE agent_dispatch_attempts SET
            status = ?, provider_task_id = ?, provider_detail = ?, error_message = ?,
            completed_at = CASE WHEN ? THEN ? ELSE NULL END
          WHERE dispatch_id = ? AND attempt_number = ?
        `).run(
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.errorMessage, terminal ? 1 : 0, input.now,
          input.dispatchId, input.attempt,
        );
        insertEvent(sqlite, input.dispatchId, {
          eventType: 'transport_state',
          fromStatus: 'in_progress',
          toStatus: input.status,
          detail: {
            attempt: input.attempt,
            providerState: input.providerState,
            providerTaskId: input.providerTaskId,
            resultDigest: input.resultDigest,
          },
          createdAt: input.now,
        });
        return 'updated' as const;
      }).immediate();
    },
    async claimNext(input) {
      return sqlite.transaction(() => {
        recoverClaims(sqlite, input.now, input.agentId);
        const candidate = sqlite.prepare(`
          SELECT id FROM agent_dispatches
          WHERE external_agent_id = ? AND transport = 'pull' AND status = 'queued'
            AND available_at <= ? AND cancel_requested_at IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1
        `).get(input.agentId, input.now) as { id: string } | undefined;
        if (!candidate) return null;
        const current = state(sqlite, candidate.id)!;
        const attempt = current.attemptCount + 1;
        if (attempt > current.maxAttempts) {
          sqlite.prepare(`
            UPDATE agent_dispatches
            SET status = 'dead_letter', completed_at = ?, updated_at = ?,
                error_message = 'Maximum dispatch attempts exceeded'
            WHERE id = ? AND status = 'queued'
          `).run(input.now, input.now, candidate.id);
          insertEvent(sqlite, candidate.id, {
            eventType: 'attempts_exhausted',
            fromStatus: 'queued',
            toStatus: 'dead_letter',
            detail: { attempt },
            createdAt: input.now,
          });
          return null;
        }
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET status = 'claimed', attempt_count = ?, claim_token_hash = ?,
              claimed_at = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?,
              error_message = NULL
          WHERE id = ? AND status = 'queued'
        `).run(
          attempt, input.claimTokenHash, input.now, input.leaseExpiresAt,
          input.now, input.now, candidate.id,
        );
        if (updated.changes !== 1) return null;
        sqlite.prepare(`
          INSERT INTO agent_dispatch_attempts (
            id, dispatch_id, attempt_number, status, started_at
          ) VALUES (?, ?, ?, 'claimed', ?)
        `).run(input.attemptId, candidate.id, attempt, input.now);
        insertEvent(sqlite, candidate.id, {
          eventType: 'claimed',
          fromStatus: 'queued',
          toStatus: 'claimed',
          detail: { attempt, leaseExpiresAt: input.leaseExpiresAt },
          createdAt: input.now,
        });
        return {
          dispatchId: candidate.id,
          attempt,
          leaseExpiresAt: input.leaseExpiresAt,
          payload: current.payloadPreview,
        };
      }).immediate();
    },
    async submitResult(input: DispatchResultPersistenceInput) {
      return sqlite.transaction(() => {
        const current = state(sqlite, input.dispatchId);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.transport === 'pull') {
          if (!equalHash(input.authorization.claimTokenHash, current.claimTokenHash)) {
            throw new ExternalAgentError('Invalid claim token', 'UNAUTHORIZED', 401);
          }
        } else if (!input.authorization.agentAuthenticated) {
          throw new ExternalAgentError(
            'Authenticated agent result required',
            'UNAUTHORIZED',
            401,
          );
        }
        if (TERMINAL.has(current.status)) {
          if (current.resultDigest === input.digest) {
            return { duplicate: true, status: current.status };
          }
          throw new ExternalAgentError(
            `Dispatch is already terminal (${current.status})`,
            'TERMINAL_DISPATCH',
            409,
          );
        }
        if (current.deadlineAt && current.deadlineAt <= input.now) {
          expireOne(sqlite, current, input.now);
          return { duplicate: false, status: 'timed_out' as const, expired: true };
        }
        if (!ACTIVE_RESULT.has(current.status)) {
          throw new ExternalAgentError(
            `Dispatch cannot accept results while ${current.status}`,
            'INVALID_TRANSITION',
            409,
          );
        }
        if (current.transport === 'pull') {
          if (!current.leaseExpiresAt || current.leaseExpiresAt <= input.now) {
            throw new ExternalAgentError('Claim lease expired', 'LEASE_EXPIRED', 409);
          }
          if (input.status === 'queued') {
            throw new ExternalAgentError(
              'Pull results cannot return an active claim to the queue',
              'INVALID_TRANSITION',
              409,
            );
          }
        }
        const terminal = input.status === 'completed' || input.status === 'failed';
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches SET
            status = ?, provider_task_id = COALESCE(?, provider_task_id),
            provider_detail = COALESCE(?, provider_detail),
            result = COALESCE(?, result), result_digest = ?,
            result_status = CASE WHEN ? = 'completed' THEN 'pending_review' ELSE result_status END,
            error_message = ?,
            github_pull_request_url = COALESCE(?, github_pull_request_url),
            repository = COALESCE(?, repository), base_ref = COALESCE(?, base_ref),
            branch_ref = COALESCE(?, branch_ref), commit_sha = COALESCE(?, commit_sha),
            checks = COALESCE(?, checks), artifacts = COALESCE(?, artifacts),
            lease_expires_at = CASE WHEN ? THEN NULL ELSE ? END,
            completed_at = CASE WHEN ? THEN ? ELSE NULL END, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.result ? JSON.stringify(input.result) : null, input.digest,
          input.status, input.errorMessage, input.pullRequestUrl, input.repository,
          input.baseRef, input.branchRef, input.commitSha,
          input.checks ? JSON.stringify(input.checks) : null,
          input.artifacts ? JSON.stringify(input.artifacts) : null,
          terminal ? 1 : 0, input.leaseExpiresAt, terminal ? 1 : 0, input.now,
          input.now, input.dispatchId, current.status,
        );
        if (updated.changes !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        sqlite.prepare(`
          UPDATE agent_dispatch_attempts SET
            status = ?, provider_task_id = COALESCE(?, provider_task_id),
            provider_detail = COALESCE(?, provider_detail), error_message = ?,
            completed_at = CASE WHEN ? THEN ? ELSE NULL END
          WHERE dispatch_id = ? AND attempt_number = ?
        `).run(
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.errorMessage, terminal ? 1 : 0, input.now,
          input.dispatchId, current.attemptCount,
        );
        insertEvent(sqlite, input.dispatchId, {
          eventType: 'result_received',
          fromStatus: current.status,
          toStatus: input.status,
          detail: {
            attempt: current.attemptCount,
            providerState: input.providerState,
            providerTaskId: input.providerTaskId,
            resultDigest: input.digest,
          },
          createdAt: input.now,
        });
        return { duplicate: false, status: input.status };
      }).immediate();
    },
    async cancel(id, now) {
      return sqlite.transaction(() => {
        const current = state(sqlite, id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.status === 'cancelled') return false;
        if (TERMINAL.has(current.status)) {
          throw new ExternalAgentError(
            `Dispatch is already terminal (${current.status})`,
            'TERMINAL_DISPATCH',
            409,
          );
        }
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET status = 'cancelled', cancel_requested_at = ?, completed_at = ?,
              claim_token_hash = NULL, lease_expires_at = NULL,
              error_message = 'Dispatch cancelled by user', updated_at = ?
          WHERE id = ? AND status = ?
        `).run(now, now, now, id, current.status);
        if (updated.changes !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        sqlite.prepare(`
          UPDATE agent_dispatch_attempts
          SET status = 'cancelled', error_message = 'Dispatch cancelled by user',
              completed_at = ?
          WHERE dispatch_id = ? AND attempt_number = ? AND completed_at IS NULL
        `).run(now, id, current.attemptCount);
        insertEvent(sqlite, id, {
          eventType: 'cancelled',
          fromStatus: current.status,
          toStatus: 'cancelled',
          detail: { providerTaskId: current.providerTaskId },
          createdAt: now,
        });
        return true;
      }).immediate();
    },
    async retry(input) {
      sqlite.transaction(() => {
        const current = state(sqlite, input.id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (!['failed', 'timed_out', 'dead_letter', 'cancelled'].includes(current.status)) {
          throw new ExternalAgentError(
            `Dispatch cannot be retried while ${current.status}`,
            'INVALID_TRANSITION',
            409,
          );
        }
        rateLimit(sqlite, input.agentId, input.maxRequestsPerMinute, input.now);
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET status = 'queued', max_attempts = MAX(max_attempts, attempt_count + 1),
              available_at = ?, provider_task_id = NULL, provider_detail = NULL,
              result = NULL, result_digest = NULL, result_status = NULL,
              claim_token_hash = NULL, claimed_at = NULL, lease_expires_at = NULL,
              cancel_requested_at = NULL, github_issue_url = NULL,
              github_pull_request_url = NULL, branch_ref = NULL, commit_sha = NULL,
              checks = NULL, artifacts = NULL, error_message = NULL,
              completed_at = NULL, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(input.now, input.now, input.id, current.status);
        if (updated.changes !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        insertEvent(sqlite, input.id, {
          eventType: 'retry_requested',
          fromStatus: current.status,
          toStatus: 'queued',
          detail: {
            nextAttempt: current.attemptCount + 1,
            executionLocality: input.executionLocality,
          },
          createdAt: input.now,
        });
      }).immediate();
    },
    async markWaiting(id, detail, now) {
      sqlite.transaction(() => {
        const current = state(sqlite, id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.status !== 'claimed' && current.status !== 'in_progress') {
          throw new ExternalAgentError(
            `Dispatch cannot wait while ${current.status}`,
            'INVALID_TRANSITION',
            409,
          );
        }
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches SET status = 'waiting_for_user', updated_at = ?
          WHERE id = ? AND status = ?
        `).run(now, id, current.status);
        if (updated.changes !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        sqlite.prepare(`
          UPDATE agent_dispatch_attempts SET status = 'waiting_for_user'
          WHERE dispatch_id = ? AND attempt_number = ?
        `).run(id, current.attemptCount);
        insertEvent(sqlite, id, {
          eventType: 'waiting_for_user',
          fromStatus: current.status,
          toStatus: 'waiting_for_user',
          detail,
          createdAt: now,
        });
      }).immediate();
    },
    async expire(now) {
      return sqlite.transaction(() => {
        recoverClaims(sqlite, now);
        const rows = sqlite.prepare(`
          SELECT id, status, attempt_count AS attemptCount
          FROM agent_dispatches
          WHERE status IN ('queued', 'claimed', 'in_progress', 'waiting_for_user')
            AND deadline_at IS NOT NULL AND deadline_at <= ?
        `).all(now) as Array<{
          id: string;
          status: AgentDispatchStatus;
          attemptCount: number;
        }>;
        rows.forEach((row) => expireOne(sqlite, row, now));
        return rows.length;
      }).immediate();
    },
    async review(id, decision, now) {
      sqlite.transaction(() => {
        const updated = sqlite.prepare(`
          UPDATE agent_dispatches
          SET result_status = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'completed' AND result_status = 'pending_review'
        `).run(decision, now, now, id);
        if (updated.changes !== 1) {
          throw new ExternalAgentError(
            'Dispatch has no pending result review',
            'INVALID_TRANSITION',
            409,
          );
        }
        insertEvent(sqlite, id, {
          eventType: 'result_reviewed',
          fromStatus: 'completed',
          toStatus: 'completed',
          detail: { decision },
          createdAt: now,
        });
      }).immediate();
    },
    async cleanup(now) {
      return sqlite.transaction(() => {
        const rows = sqlite.prepare(`
          SELECT d.id, d.completed_at AS completedAt, a.data_policy AS dataPolicy
          FROM agent_dispatches d
          JOIN external_agents a ON a.id = d.external_agent_id
          WHERE d.status IN ('completed', 'failed', 'timed_out', 'dead_letter', 'cancelled')
            AND d.completed_at IS NOT NULL
        `).all() as Array<{ id: string; completedAt: string; dataPolicy: string }>;
        const expired = rows.filter((row) => {
          const policy = json<ExternalAgentRecord['dataPolicy']>(row.dataPolicy, {
            allowedClassifications: [],
            fieldAllowlist: [],
            retentionDays: 30,
            maxRequestsPerMinute: 30,
          });
          return new Date(row.completedAt).getTime()
            + policy.retentionDays * 86_400_000 <= new Date(now).getTime();
        });
        for (const row of expired) {
          sqlite.prepare('DELETE FROM agent_dispatches WHERE id = ?').run(row.id);
        }
        return expired.length;
      }).immediate();
    },
  };

  return { registry, payloads, dispatches };
}
