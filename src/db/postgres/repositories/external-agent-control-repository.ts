import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
} from '@/db/persistence/external-agent-control';

const TERMINAL = new Set<AgentDispatchStatus>([
  'completed', 'failed', 'timed_out', 'dead_letter', 'cancelled',
]);
const ACTIVE_RESULT = new Set<AgentDispatchStatus>([
  'queued', 'claimed', 'in_progress', 'waiting_for_user',
]);
const MAX_TRANSACTION_ATTEMPTS = 3;

const AGENT_COLUMNS = `
  id, name, type, transport, execution_locality AS "executionLocality",
  description, endpoint, auth_type AS "authType",
  auth_credential_ref AS "authCredentialRef", capabilities,
  input_format AS "inputFormat", output_format AS "outputFormat",
  inbound_webhook_id AS "inboundWebhookId", data_policy AS "dataPolicy",
  enabled, created_at AS "createdAt", updated_at AS "updatedAt",
  deleted_at AS "deletedAt"
`;
const DISPATCH_COLUMNS = `
  id, external_agent_id AS "externalAgentId", idempotency_key AS "idempotencyKey",
  instruction, scope, status, transport, execution_locality AS "executionLocality",
  data_classification AS "dataClassification", allowed_actions AS "allowedActions",
  disclosed_fields AS "disclosedFields", payload_preview AS "payloadPreview",
  preview_hash AS "previewHash", provider_task_id AS "providerTaskId",
  provider_detail AS "providerDetail", result, result_digest AS "resultDigest",
  result_status AS "resultStatus", claim_token_hash AS "claimTokenHash",
  claimed_at AS "claimedAt", lease_expires_at AS "leaseExpiresAt",
  attempt_count AS "attemptCount", max_attempts AS "maxAttempts",
  available_at AS "availableAt", deadline_at AS "deadlineAt",
  cancel_requested_at AS "cancelRequestedAt", github_issue_url AS "githubIssueUrl",
  github_pull_request_url AS "githubPullRequestUrl", repository,
  base_ref AS "baseRef", branch_ref AS "branchRef", commit_sha AS "commitSha",
  checks, artifacts, error_message AS "errorMessage", confirmed_at AS "confirmedAt",
  started_at AS "startedAt", completed_at AS "completedAt",
  reviewed_at AS "reviewedAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

function retryable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  return code === '40001' || code === '40P01';
}

function isUniqueConstraintViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const actualConstraint = 'constraint' in error ? String(error.constraint) : '';
  return code === '23505' && actualConstraint === constraint;
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    } finally {
      client.release();
    }
  }
  throw new Error('External-agent transaction exhausted retries');
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

async function assertProtectedInboundWebhook(
  client: PoolClient,
  id: string | null,
): Promise<void> {
  if (!id) return;
  const [webhook] = await query<{ enabled: boolean; secret: string | null }>(client, `
    SELECT enabled, secret FROM inbound_webhooks WHERE id = $1 FOR SHARE
  `, [id]);
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

async function insertEvent(
  client: PoolClient,
  dispatchId: string,
  event: DispatchEventInput,
): Promise<void> {
  await client.query(`
    INSERT INTO agent_dispatch_events (
      dispatch_id, event_type, from_status, to_status, detail, created_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [
    dispatchId,
    event.eventType,
    event.fromStatus,
    event.toStatus,
    JSON.stringify(event.detail),
    event.createdAt,
  ]);
}

async function lockedState(
  client: PoolClient,
  id: string,
): Promise<AgentDispatchRecord | null> {
  const [row] = await query<AgentDispatchRecord & QueryResultRow>(client, `
    SELECT ${DISPATCH_COLUMNS} FROM agent_dispatches WHERE id = $1 FOR UPDATE
  `, [id]);
  return row ?? null;
}

async function rateLimit(
  client: PoolClient,
  agentId: string,
  maximum: number,
  now: string,
): Promise<void> {
  const since = new Date(new Date(now).getTime() - 60_000).toISOString();
  const [row] = await query<{ count: string }>(client, `
    SELECT COUNT(*)::text AS count
    FROM agent_dispatch_events
    WHERE event_type IN ('dispatch_confirmed', 'retry_requested')
      AND created_at >= $1
      AND dispatch_id IN (
        SELECT id FROM agent_dispatches WHERE external_agent_id = $2
      )
  `, [since, agentId]);
  if (Number(row?.count ?? 0) >= maximum) {
    throw new ExternalAgentError(
      'External-agent rate limit exceeded',
      'RATE_LIMITED',
      429,
    );
  }
}

async function expireOne(
  client: PoolClient,
  dispatch: Pick<AgentDispatchRecord, 'id' | 'status' | 'attemptCount'>,
  now: string,
): Promise<void> {
  const result = await client.query(`
    UPDATE agent_dispatches
    SET status = 'timed_out', completed_at = $1, updated_at = $1,
        claim_token_hash = NULL, lease_expires_at = NULL,
        error_message = 'Dispatch exceeded its deadline'
    WHERE id = $2 AND status = $3
  `, [now, dispatch.id, dispatch.status]);
  if (result.rowCount !== 1) {
    throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
  }
  await client.query(`
    UPDATE agent_dispatch_attempts
    SET status = 'timed_out', error_message = 'Dispatch exceeded its deadline',
        completed_at = $1
    WHERE dispatch_id = $2 AND attempt_number = $3 AND completed_at IS NULL
  `, [now, dispatch.id, dispatch.attemptCount]);
  await insertEvent(client, dispatch.id, {
    eventType: 'timed_out',
    fromStatus: dispatch.status,
    toStatus: 'timed_out',
    detail: {},
    createdAt: now,
  });
}

async function recoverClaims(
  client: PoolClient,
  now: string,
  agentId?: string,
): Promise<void> {
  const rows = await query<{
    id: string;
    status: AgentDispatchStatus;
    attemptCount: number;
    maxAttempts: number;
  }>(client, `
    SELECT id, status, attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
    FROM agent_dispatches
    WHERE transport = 'pull'
      AND status IN ('claimed', 'in_progress', 'waiting_for_user')
      AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
      ${agentId ? 'AND external_agent_id = $2' : ''}
    ORDER BY created_at, id
    FOR UPDATE
  `, agentId ? [now, agentId] : [now]);
  for (const row of rows) {
    const next: AgentDispatchStatus = row.attemptCount >= row.maxAttempts
      ? 'dead_letter'
      : 'queued';
    const updated = await client.query(`
      UPDATE agent_dispatches
      SET status = $1, available_at = $2, claim_token_hash = NULL,
          claimed_at = NULL, lease_expires_at = NULL,
          completed_at = CASE WHEN $1 = 'dead_letter' THEN $2 ELSE NULL END,
          error_message = 'Claim lease expired', updated_at = $2
      WHERE id = $3 AND status = $4
    `, [next, now, row.id, row.status]);
    if (updated.rowCount !== 1) continue;
    await client.query(`
      UPDATE agent_dispatch_attempts
      SET status = 'lease_expired', error_message = 'Claim lease expired',
          completed_at = $1
      WHERE dispatch_id = $2 AND attempt_number = $3
    `, [now, row.id, row.attemptCount]);
    await insertEvent(client, row.id, {
      eventType: 'claim_expired',
      fromStatus: row.status,
      toStatus: next,
      detail: { attempt: row.attemptCount },
      createdAt: now,
    });
  }
}

export function createPostgresExternalAgentControlRepository(
  pool: Pool,
): ExternalAgentControlPersistence {
  const registry: ExternalAgentControlPersistence['registry'] = {
    async list(options = {}) {
      return query<ExternalAgentRecord & QueryResultRow>(pool, `
        SELECT ${AGENT_COLUMNS} FROM external_agents
        ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
        ORDER BY created_at ASC, id ASC
      `);
    },
    async get(id, includeDeleted = false) {
      const [agent] = await query<ExternalAgentRecord & QueryResultRow>(pool, `
        SELECT ${AGENT_COLUMNS} FROM external_agents
        WHERE id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      `, [id]);
      return agent ?? null;
    },
    async create(record: ExternalAgentCreateRecord) {
      return transaction(pool, async (client) => {
        await assertProtectedInboundWebhook(client, record.inboundWebhookId);
        const [created] = await query<ExternalAgentRecord & QueryResultRow>(client, `
          INSERT INTO external_agents (
            id, name, type, transport, execution_locality, description, endpoint,
            auth_type, auth_credential_ref, capabilities, input_format, output_format,
            inbound_webhook_id, data_policy, enabled, created_at, updated_at, deleted_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
            $13, $14::jsonb, $15, $16, $17, $18
          )
          RETURNING ${AGENT_COLUMNS}
        `, [
          record.id, record.name, record.type, record.transport,
          record.executionLocality, record.description, record.endpoint,
          record.authType, record.authCredentialRef, JSON.stringify(record.capabilities),
          record.inputFormat, record.outputFormat, record.inboundWebhookId,
          JSON.stringify(record.dataPolicy), record.enabled, record.createdAt,
          record.updatedAt, record.deletedAt,
        ]);
        return created;
      });
    },
    async update(id, record: ExternalAgentUpdateRecord) {
      return transaction(pool, async (client) => {
        await assertProtectedInboundWebhook(client, record.inboundWebhookId);
        const [updated] = await query<ExternalAgentRecord & QueryResultRow>(client, `
          UPDATE external_agents SET
            name = $2, type = $3, transport = $4, execution_locality = $5,
            description = $6, endpoint = $7, auth_type = $8,
            auth_credential_ref = $9, capabilities = $10::jsonb,
            input_format = $11, output_format = $12, inbound_webhook_id = $13,
            data_policy = $14::jsonb, enabled = $15, updated_at = $16,
            deleted_at = $17
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING ${AGENT_COLUMNS}
        `, [
          id, record.name, record.type, record.transport, record.executionLocality,
          record.description, record.endpoint, record.authType,
          record.authCredentialRef, JSON.stringify(record.capabilities),
          record.inputFormat, record.outputFormat, record.inboundWebhookId,
          JSON.stringify(record.dataPolicy), record.enabled, record.updatedAt,
          record.deletedAt,
        ]);
        return updated ?? null;
      });
    },
    async softDelete(id, now) {
      const result = await pool.query(`
        UPDATE external_agents
        SET enabled = FALSE, deleted_at = $1, updated_at = $1
        WHERE id = $2 AND deleted_at IS NULL
      `, [now, id]);
      return result.rowCount === 1;
    },
  };

  const payloads: ExternalAgentControlPersistence['payloads'] = {
    async snapshot(scope) {
      return transaction(pool, async (client) => {
        const project = scope.projectId
        ? (await query<NonNullable<AgentPayloadSnapshot['project']> & QueryResultRow>(client, `
            SELECT id, name, description FROM hub_projects WHERE id = $1
          `, [scope.projectId]))[0]
        : undefined;
      const ids = new Set(scope.taskIds ?? []);
      if (scope.projectId) {
        const memberships = await query<{ taskId: string }>(client, `
          SELECT task_id AS "taskId" FROM task_projects
          WHERE project_id = $1 ORDER BY task_id
        `, [scope.projectId]);
        memberships.forEach(({ taskId }) => ids.add(taskId));
      }
      const taskRows = ids.size
        ? await query<AgentPayloadSnapshot['tasks'][number] & QueryResultRow>(client, `
            SELECT id, title, description, priority, status,
                   connector_type AS "connectorType"
            FROM tasks WHERE id = ANY($1::text[]) ORDER BY id
          `, [[...ids]])
        : [];
      const tagsByTask = new Map<string, string[]>();
      if (taskRows.length) {
        const tagRows = await query<{ taskId: string; name: string }>(client, `
          SELECT tt.task_id AS "taskId", t.name
          FROM task_tags tt INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id = ANY($1::text[])
          ORDER BY tt.task_id, t.name
        `, [taskRows.map(({ id }) => id)]);
        for (const row of tagRows) {
          tagsByTask.set(row.taskId, [...(tagsByTask.get(row.taskId) ?? []), row.name]);
        }
      }
      const phaseRows = scope.projectId
        ? await query<{
            id: string;
            name: string;
            description: string | null;
            sortOrder: number;
          }>(client, `
            SELECT id, name, description, sort_order AS "sortOrder"
            FROM project_phases WHERE project_id = $1
            ORDER BY sort_order, id
          `, [scope.projectId])
        : [];
      const itemsByPhase = new Map<string, string[]>();
      if (phaseRows.length) {
        const rows = await query<{ phaseId: string; taskId: string }>(client, `
          SELECT phase_id AS "phaseId", task_id AS "taskId"
          FROM project_phase_items
          WHERE phase_id = ANY($1::text[])
          ORDER BY phase_id, sort_order, task_id
        `, [phaseRows.map(({ id }) => id)]);
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
      });
    },
  };

  const dispatches: ExternalAgentControlPersistence['dispatches'] = {
    async get(id): Promise<AgentDispatchDetail | null> {
      const [dispatch] = await query<AgentDispatchRecord & QueryResultRow>(pool, `
        SELECT ${DISPATCH_COLUMNS} FROM agent_dispatches WHERE id = $1
      `, [id]);
      if (!dispatch) return null;
      const [attempts, events] = await Promise.all([
        query<AgentDispatchDetail['attempts'][number] & QueryResultRow>(pool, `
          SELECT id, dispatch_id AS "dispatchId", attempt_number AS "attemptNumber",
                 status, provider_task_id AS "providerTaskId",
                 provider_detail AS "providerDetail", error_message AS "errorMessage",
                 started_at AS "startedAt", completed_at AS "completedAt"
          FROM agent_dispatch_attempts WHERE dispatch_id = $1 ORDER BY attempt_number
        `, [id]),
        query<AgentDispatchDetail['events'][number] & QueryResultRow>(pool, `
          SELECT id, dispatch_id AS "dispatchId", event_type AS "eventType",
                 from_status AS "fromStatus", to_status AS "toStatus", detail,
                 created_at AS "createdAt"
          FROM agent_dispatch_events WHERE dispatch_id = $1 ORDER BY id
        `, [id]),
      ]);
      return { ...dispatch, attempts, events };
    },
    async list(options = {}) {
      const predicates: string[] = [];
      const values: unknown[] = [];
      if (options.status) {
        values.push(options.status);
        predicates.push(`status = $${values.length}`);
      }
      if (options.agentId) {
        values.push(options.agentId);
        predicates.push(`external_agent_id = $${values.length}`);
      }
      values.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
      return query<AgentDispatchRecord & QueryResultRow>(pool, `
        SELECT ${DISPATCH_COLUMNS} FROM agent_dispatches
        ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${values.length}
      `, values);
    },
    async findPreview(agentId, idempotencyKey) {
      const [row] = await query<{ id: string; previewHash: string }>(pool, `
        SELECT id, preview_hash AS "previewHash" FROM agent_dispatches
        WHERE external_agent_id = $1 AND idempotency_key = $2
      `, [agentId, idempotencyKey]);
      return row ?? null;
    },
    async createPreview(record, createdEvent) {
      try {
        return await transaction(pool, async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`external-agent-preview:${record.externalAgentId}:${record.idempotencyKey}`],
          );
          const [duplicate] = await query<{ id: string; previewHash: string }>(client, `
            SELECT id, preview_hash AS "previewHash" FROM agent_dispatches
            WHERE external_agent_id = $1 AND idempotency_key = $2
          `, [record.externalAgentId, record.idempotencyKey]);
          if (duplicate) {
            return { ...duplicate, created: false };
          }
          await client.query(`
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
              $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb,
              $11::jsonb, $12::jsonb, $13, $14, $15::jsonb, $16::jsonb, $17,
              $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
              $30, $31, $32, $33::jsonb, $34::jsonb, $35, $36, $37, $38,
              $39, $40, $41
            )
          `, [
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
          ]);
          await insertEvent(client, record.id, createdEvent);
          return { id: record.id, previewHash: record.previewHash, created: true };
        });
      } catch (error) {
        if (!isUniqueConstraintViolation(error, 'idx_agent_dispatches_agent_idempotency')) {
          throw error;
        }
        // The advisory-lock wait can retain a pre-winner serializable snapshot.
        return transaction(pool, async (client) => {
          const [duplicate] = await query<{ id: string; previewHash: string }>(client, `
            SELECT id, preview_hash AS "previewHash" FROM agent_dispatches
            WHERE external_agent_id = $1 AND idempotency_key = $2
          `, [record.externalAgentId, record.idempotencyKey]);
          if (!duplicate) throw error;
          return { ...duplicate, created: false };
        });
      }
    },
    async confirm(input) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, input.id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.externalAgentId !== input.agentId) {
          throw new ExternalAgentError('Dispatch agent changed unexpectedly', 'CONFLICT', 409);
        }
        const [destination] = await query<ExternalAgentRecord & QueryResultRow>(client, `
          SELECT ${AGENT_COLUMNS} FROM external_agents
          WHERE id = $1 FOR SHARE
        `, [input.agentId]);
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
        await rateLimit(client, input.agentId, input.maxRequestsPerMinute, input.now);
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET status = 'queued', confirmed_at = $1, available_at = $1, updated_at = $1
          WHERE id = $2 AND status = 'needs_confirmation' AND preview_hash = $3
        `, [input.now, input.id, input.previewHash]);
        if (updated.rowCount !== 1) return false;
        await insertEvent(client, input.id, {
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
      });
    },
    async beginAttempt(input) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, input.id);
        if (!current || current.status !== 'queued') return null;
        const attempt = current.attemptCount + 1;
        if (attempt > current.maxAttempts) {
          await client.query(`
            UPDATE agent_dispatches
            SET status = 'dead_letter', completed_at = $1, updated_at = $1,
                error_message = 'Maximum dispatch attempts exceeded'
            WHERE id = $2 AND status = 'queued'
          `, [input.now, input.id]);
          await insertEvent(client, input.id, {
            eventType: 'attempts_exhausted',
            fromStatus: 'queued',
            toStatus: 'dead_letter',
            detail: { attempt },
            createdAt: input.now,
          });
          return null;
        }
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET status = 'in_progress', attempt_count = $1,
              started_at = COALESCE(started_at, $2), lease_expires_at = $3,
              updated_at = $2, error_message = NULL
          WHERE id = $4 AND status = 'queued'
        `, [attempt, input.now, input.leaseExpiresAt, input.id]);
        if (updated.rowCount !== 1) return null;
        await client.query(`
          INSERT INTO agent_dispatch_attempts (
            id, dispatch_id, attempt_number, status, started_at
          ) VALUES ($1, $2, $3, 'in_progress', $4)
        `, [input.attemptId, input.id, attempt, input.now]);
        await insertEvent(client, input.id, {
          eventType: 'attempt_started',
          fromStatus: 'queued',
          toStatus: 'in_progress',
          detail: { attempt },
          createdAt: input.now,
        });
        return { attempt, leaseExpiresAt: input.leaseExpiresAt, payload: current.payloadPreview };
      });
    },
    async resumeAttempt(input) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, input.id);
        if (
          !current
          || current.status !== 'in_progress'
          || current.providerTaskId
          || !current.leaseExpiresAt
          || current.leaseExpiresAt > input.now
        ) return null;
        const updated = await client.query(`
          UPDATE agent_dispatches SET lease_expires_at = $1, updated_at = $2
          WHERE id = $3 AND status = 'in_progress' AND provider_task_id IS NULL
            AND lease_expires_at <= $2
        `, [input.leaseExpiresAt, input.now, input.id]);
        if (updated.rowCount !== 1) return null;
        await insertEvent(client, input.id, {
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
      });
    },
    async finalizeAttempt(input: DispatchFinalizeInput) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, input.dispatchId);
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
          await expireOne(client, current, input.now);
          return 'expired' as const;
        }
        const terminal = input.status === 'completed' || input.status === 'failed';
        const updated = await client.query(`
          UPDATE agent_dispatches SET
            status = $1, provider_task_id = COALESCE($2, provider_task_id),
            provider_detail = $3::jsonb, result = $4::jsonb, result_digest = $5,
            result_status = $6, error_message = $7, github_pull_request_url = $8,
            repository = COALESCE($9, repository),
            base_ref = COALESCE($10, base_ref), branch_ref = $11, commit_sha = $12,
            checks = $13::jsonb, artifacts = $14::jsonb, lease_expires_at = NULL,
            completed_at = CASE WHEN $15 THEN $16 ELSE NULL END, updated_at = $16
          WHERE id = $17 AND status = 'in_progress' AND attempt_count = $18
            AND lease_expires_at = $19
            AND (provider_task_id IS NULL OR provider_task_id = $20)
        `, [
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.result ? JSON.stringify(input.result) : null,
          input.resultDigest, input.resultStatus, input.errorMessage,
          input.pullRequestUrl, input.repository, input.baseRef, input.branchRef,
          input.commitSha, input.checks ? JSON.stringify(input.checks) : null,
          input.artifacts ? JSON.stringify(input.artifacts) : null,
          terminal, input.now, input.dispatchId, input.attempt, input.leaseExpiresAt,
          input.providerTaskId ?? null,
        ]);
        if (updated.rowCount !== 1) return 'stale' as const;
        await client.query(`
          UPDATE agent_dispatch_attempts SET
            status = $1, provider_task_id = $2, provider_detail = $3::jsonb,
            error_message = $4,
            completed_at = CASE WHEN $5 THEN $6 ELSE NULL END
          WHERE dispatch_id = $7 AND attempt_number = $8
        `, [
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.errorMessage, terminal, input.now, input.dispatchId, input.attempt,
        ]);
        await insertEvent(client, input.dispatchId, {
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
      });
    },
    async claimNext(input) {
      return transaction(pool, async (client) => {
        await recoverClaims(client, input.now, input.agentId);
        const [candidate] = await query<{ id: string }>(client, `
          SELECT id FROM agent_dispatches
          WHERE external_agent_id = $1 AND transport = 'pull' AND status = 'queued'
            AND available_at <= $2 AND cancel_requested_at IS NULL
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
        `, [input.agentId, input.now]);
        if (!candidate) return null;
        const current = await lockedState(client, candidate.id);
        if (!current || current.status !== 'queued') return null;
        const attempt = current.attemptCount + 1;
        if (attempt > current.maxAttempts) {
          await client.query(`
            UPDATE agent_dispatches
            SET status = 'dead_letter', completed_at = $1, updated_at = $1,
                error_message = 'Maximum dispatch attempts exceeded'
            WHERE id = $2 AND status = 'queued'
          `, [input.now, candidate.id]);
          await insertEvent(client, candidate.id, {
            eventType: 'attempts_exhausted',
            fromStatus: 'queued',
            toStatus: 'dead_letter',
            detail: { attempt },
            createdAt: input.now,
          });
          return null;
        }
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET status = 'claimed', attempt_count = $1, claim_token_hash = $2,
              claimed_at = $3, lease_expires_at = $4,
              started_at = COALESCE(started_at, $3), updated_at = $3,
              error_message = NULL
          WHERE id = $5 AND status = 'queued'
        `, [attempt, input.claimTokenHash, input.now, input.leaseExpiresAt, candidate.id]);
        if (updated.rowCount !== 1) return null;
        await client.query(`
          INSERT INTO agent_dispatch_attempts (
            id, dispatch_id, attempt_number, status, started_at
          ) VALUES ($1, $2, $3, 'claimed', $4)
        `, [input.attemptId, candidate.id, attempt, input.now]);
        await insertEvent(client, candidate.id, {
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
      });
    },
    async submitResult(input: DispatchResultPersistenceInput) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, input.dispatchId);
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
          await expireOne(client, current, input.now);
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
        const updated = await client.query(`
          UPDATE agent_dispatches SET
            status = $1, provider_task_id = COALESCE($2, provider_task_id),
            provider_detail = COALESCE($3::jsonb, provider_detail),
            result = COALESCE($4::jsonb, result), result_digest = $5,
            result_status = CASE WHEN $1 = 'completed' THEN 'pending_review' ELSE result_status END,
            error_message = $6,
            github_pull_request_url = COALESCE($7, github_pull_request_url),
            repository = COALESCE($8, repository), base_ref = COALESCE($9, base_ref),
            branch_ref = COALESCE($10, branch_ref), commit_sha = COALESCE($11, commit_sha),
            checks = COALESCE($12::jsonb, checks),
            artifacts = COALESCE($13::jsonb, artifacts),
            lease_expires_at = CASE WHEN $14 THEN NULL ELSE $15 END,
            completed_at = CASE WHEN $14 THEN $16 ELSE NULL END, updated_at = $16
          WHERE id = $17 AND status = $18
        `, [
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.result ? JSON.stringify(input.result) : null, input.digest,
          input.errorMessage, input.pullRequestUrl, input.repository, input.baseRef,
          input.branchRef, input.commitSha,
          input.checks ? JSON.stringify(input.checks) : null,
          input.artifacts ? JSON.stringify(input.artifacts) : null,
          terminal, input.leaseExpiresAt, input.now, input.dispatchId, current.status,
        ]);
        if (updated.rowCount !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        await client.query(`
          UPDATE agent_dispatch_attempts SET
            status = $1, provider_task_id = COALESCE($2, provider_task_id),
            provider_detail = COALESCE($3::jsonb, provider_detail),
            error_message = $4,
            completed_at = CASE WHEN $5 THEN $6 ELSE NULL END
          WHERE dispatch_id = $7 AND attempt_number = $8
        `, [
          input.status, input.providerTaskId ?? null,
          input.providerDetail ? JSON.stringify(input.providerDetail) : null,
          input.errorMessage, terminal, input.now, input.dispatchId,
          current.attemptCount,
        ]);
        await insertEvent(client, input.dispatchId, {
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
      });
    },
    async cancel(id, now) {
      return transaction(pool, async (client) => {
        const current = await lockedState(client, id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.status === 'cancelled') return false;
        if (TERMINAL.has(current.status)) {
          throw new ExternalAgentError(
            `Dispatch is already terminal (${current.status})`,
            'TERMINAL_DISPATCH',
            409,
          );
        }
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET status = 'cancelled', cancel_requested_at = $1, completed_at = $1,
              claim_token_hash = NULL, lease_expires_at = NULL,
              error_message = 'Dispatch cancelled by user', updated_at = $1
          WHERE id = $2 AND status = $3
        `, [now, id, current.status]);
        if (updated.rowCount !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        await client.query(`
          UPDATE agent_dispatch_attempts
          SET status = 'cancelled', error_message = 'Dispatch cancelled by user',
              completed_at = $1
          WHERE dispatch_id = $2 AND attempt_number = $3 AND completed_at IS NULL
        `, [now, id, current.attemptCount]);
        await insertEvent(client, id, {
          eventType: 'cancelled',
          fromStatus: current.status,
          toStatus: 'cancelled',
          detail: { providerTaskId: current.providerTaskId },
          createdAt: now,
        });
        return true;
      });
    },
    async retry(input) {
      await transaction(pool, async (client) => {
        const current = await lockedState(client, input.id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (!['failed', 'timed_out', 'dead_letter', 'cancelled'].includes(current.status)) {
          throw new ExternalAgentError(
            `Dispatch cannot be retried while ${current.status}`,
            'INVALID_TRANSITION',
            409,
          );
        }
        await rateLimit(client, input.agentId, input.maxRequestsPerMinute, input.now);
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET status = 'queued',
              max_attempts = GREATEST(max_attempts, attempt_count + 1),
              available_at = $1, provider_task_id = NULL, provider_detail = NULL,
              result = NULL, result_digest = NULL, result_status = NULL,
              claim_token_hash = NULL, claimed_at = NULL, lease_expires_at = NULL,
              cancel_requested_at = NULL, github_issue_url = NULL,
              github_pull_request_url = NULL, branch_ref = NULL, commit_sha = NULL,
              checks = NULL, artifacts = NULL, error_message = NULL,
              completed_at = NULL, updated_at = $1
          WHERE id = $2 AND status = $3
        `, [input.now, input.id, current.status]);
        if (updated.rowCount !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        await insertEvent(client, input.id, {
          eventType: 'retry_requested',
          fromStatus: current.status,
          toStatus: 'queued',
          detail: {
            nextAttempt: current.attemptCount + 1,
            executionLocality: input.executionLocality,
          },
          createdAt: input.now,
        });
      });
    },
    async markWaiting(id, detail, now) {
      await transaction(pool, async (client) => {
        const current = await lockedState(client, id);
        if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
        if (current.status !== 'claimed' && current.status !== 'in_progress') {
          throw new ExternalAgentError(
            `Dispatch cannot wait while ${current.status}`,
            'INVALID_TRANSITION',
            409,
          );
        }
        const updated = await client.query(`
          UPDATE agent_dispatches SET status = 'waiting_for_user', updated_at = $1
          WHERE id = $2 AND status = $3
        `, [now, id, current.status]);
        if (updated.rowCount !== 1) {
          throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
        }
        await client.query(`
          UPDATE agent_dispatch_attempts SET status = 'waiting_for_user'
          WHERE dispatch_id = $1 AND attempt_number = $2
        `, [id, current.attemptCount]);
        await insertEvent(client, id, {
          eventType: 'waiting_for_user',
          fromStatus: current.status,
          toStatus: 'waiting_for_user',
          detail,
          createdAt: now,
        });
      });
    },
    async expire(now) {
      return transaction(pool, async (client) => {
        await recoverClaims(client, now);
        const rows = await query<{
          id: string;
          status: AgentDispatchStatus;
          attemptCount: number;
        }>(client, `
          SELECT id, status, attempt_count AS "attemptCount"
          FROM agent_dispatches
          WHERE status IN ('queued', 'claimed', 'in_progress', 'waiting_for_user')
            AND deadline_at IS NOT NULL AND deadline_at <= $1
          ORDER BY created_at, id FOR UPDATE
        `, [now]);
        for (const row of rows) await expireOne(client, row, now);
        return rows.length;
      });
    },
    async review(id, decision, now) {
      await transaction(pool, async (client) => {
        const updated = await client.query(`
          UPDATE agent_dispatches
          SET result_status = $1, reviewed_at = $2, updated_at = $2
          WHERE id = $3 AND status = 'completed' AND result_status = 'pending_review'
        `, [decision, now, id]);
        if (updated.rowCount !== 1) {
          throw new ExternalAgentError(
            'Dispatch has no pending result review',
            'INVALID_TRANSITION',
            409,
          );
        }
        await insertEvent(client, id, {
          eventType: 'result_reviewed',
          fromStatus: 'completed',
          toStatus: 'completed',
          detail: { decision },
          createdAt: now,
        });
      });
    },
    async cleanup(now) {
      return transaction(pool, async (client) => {
        const rows = await query<{
          id: string;
          completedAt: string;
          retentionDays: number;
        }>(client, `
          SELECT d.id, d.completed_at AS "completedAt",
                 (a.data_policy->>'retentionDays')::integer AS "retentionDays"
          FROM agent_dispatches d
          JOIN external_agents a ON a.id = d.external_agent_id
          WHERE d.status IN ('completed', 'failed', 'timed_out', 'dead_letter', 'cancelled')
            AND d.completed_at IS NOT NULL
          FOR UPDATE OF d
        `);
        const expired = rows.filter((row) =>
          new Date(row.completedAt).getTime()
            + row.retentionDays * 86_400_000 <= new Date(now).getTime());
        if (expired.length) {
          await client.query(
            'DELETE FROM agent_dispatches WHERE id = ANY($1::text[])',
            [expired.map(({ id }) => id)],
          );
        }
        return expired.length;
      });
    },
  };

  return { registry, payloads, dispatches };
}
