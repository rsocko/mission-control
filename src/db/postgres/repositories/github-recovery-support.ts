import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ExternalEntityIdentity,
  ExternalEntityLocatorEvidence,
  NormalizedExternalEntityLocator,
} from '@/lib/external-identities/types';
import type { GitHubRecoveryTaskTransferBinding } from '@/db/persistence/github-recovery';
import { asRecord, asStringArray, readApiOrigin } from '@/db/persistence/github-recovery-values';

export type RecoveryClient = Pool | PoolClient;

export const MAX_COLLISION_IDS = 50;

export async function query<T>(
  client: RecoveryClient,
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await client.query(text, [...params]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * A short, bounded PostgreSQL transaction. No callback passed into `work` may
 * perform remote I/O: the recovery services keep every GitHub HTTP call and
 * retry sleep outside these boundaries.
 */
export async function transaction<T>(
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

export interface RecoveryEntityRow {
  id: string;
  provider: string;
  hostKey: string;
  entityType: string;
  stableId: string;
  nextLocatorRevision: number;
}

export interface RecoveryLocatorRow extends NormalizedExternalEntityLocator {
  id: string;
  externalEntityId: string;
  repositoryEntityId: string | null;
  validFrom: string;
  validTo: string | null;
  lastSeenAt: string;
  observationSource: string;
  locatorRevision: number;
}

export type RecoveryLocatorPreflight =
  | { state: 'unchanged'; locator: NormalizedExternalEntityLocator; current: RecoveryLocatorRow }
  | {
      state: 'update';
      locator: NormalizedExternalEntityLocator;
      current: RecoveryLocatorRow | null;
    }
  | {
      state: 'collision';
      locator: NormalizedExternalEntityLocator;
      current: RecoveryLocatorRow | null;
      collisionCategory: string;
      conflictingEntityId: string;
    };

export interface RecoveryLocatorObservation {
  entityId: string;
  identity: ExternalEntityIdentity;
  locator: ExternalEntityLocatorEvidence;
  repositoryEntityId: string | null;
  observedAt: string;
}

const LOCATOR_COLUMNS = `
  id,
  external_entity_id AS "externalEntityId",
  repository_entity_id AS "repositoryEntityId",
  owner,
  repository,
  owner_key AS "ownerKey",
  repository_key AS "repositoryKey",
  issue_number AS "issueNumber",
  api_url AS "apiUrl",
  web_url AS "webUrl",
  valid_from AS "validFrom",
  valid_to AS "validTo",
  last_seen_at AS "lastSeenAt",
  observation_source AS "observationSource",
  locator_revision AS "locatorRevision"
`;

const ENTITY_COLUMNS = `
  id,
  provider,
  host_key AS "hostKey",
  entity_type AS "entityType",
  stable_id AS "stableId",
  next_locator_revision AS "nextLocatorRevision"
`;

export function digestIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeLocator(
  locator: ExternalEntityLocatorEvidence,
): NormalizedExternalEntityLocator {
  return {
    owner: locator.owner,
    repository: locator.repository,
    ownerKey: locator.owner.toLowerCase(),
    repositoryKey: locator.repository.toLowerCase(),
    issueNumber: locator.issueNumber ?? null,
    apiUrl: locator.apiUrl ?? null,
    webUrl: locator.webUrl ?? null,
  };
}

function sameLocator(
  current: RecoveryLocatorRow,
  locator: NormalizedExternalEntityLocator,
): boolean {
  return current.owner === locator.owner
    && current.repository === locator.repository
    && current.ownerKey === locator.ownerKey
    && current.repositoryKey === locator.repositoryKey
    && current.issueNumber === locator.issueNumber
    && current.apiUrl === locator.apiUrl
    && current.webUrl === locator.webUrl;
}

function mergeLocator(
  locator: NormalizedExternalEntityLocator,
  current: RecoveryLocatorRow | null,
): NormalizedExternalEntityLocator {
  if (
    !current
    || current.owner !== locator.owner
    || current.repository !== locator.repository
    || current.issueNumber !== locator.issueNumber
  ) {
    return locator;
  }
  return {
    ...locator,
    apiUrl: locator.apiUrl ?? current.apiUrl,
    webUrl: locator.webUrl ?? current.webUrl,
  };
}

function validateIdentity(identity: ExternalEntityIdentity): void {
  if (!identity.provider || !identity.hostKey || !identity.stableId) {
    throw new Error('External entity key is incomplete');
  }
  if (identity.entityType !== 'repository' && identity.entityType !== 'issue') {
    throw new Error('External entity type is invalid');
  }
}

function validateObservation(input: RecoveryLocatorObservation): void {
  validateIdentity(input.identity);
  if (!input.locator.owner || !input.locator.repository) {
    throw new Error('External identity observation is incomplete');
  }
  if (!input.observedAt) throw new Error('External locator observation time is required');
  if (input.identity.entityType === 'issue') {
    if (
      !Number.isSafeInteger(input.locator.issueNumber)
      || (input.locator.issueNumber ?? 0) <= 0
    ) {
      throw new Error('Issue identity observation requires a positive issue number');
    }
  } else if (input.locator.issueNumber !== undefined) {
    throw new Error('Repository locator must not include an issue number');
  }
}

export async function requireEntity(
  client: RecoveryClient,
  entityId: string,
  identity: ExternalEntityIdentity,
  forUpdate = false,
): Promise<RecoveryEntityRow> {
  if (!entityId) throw new Error('External entity ID is required');
  validateIdentity(identity);
  const result = await query<RecoveryEntityRow>(
    client,
    `SELECT ${ENTITY_COLUMNS} FROM external_entities WHERE id = $1 LIMIT 1${
      forUpdate ? ' FOR UPDATE' : ''
    }`,
    [entityId],
  );
  const entity = result.rows[0];
  if (!entity) throw new Error('External entity was not found');
  if (
    entity.provider !== identity.provider
    || entity.hostKey !== identity.hostKey
    || entity.entityType !== identity.entityType
    || entity.stableId !== identity.stableId
  ) {
    throw new Error('External entity ID does not match the supplied key');
  }
  return entity;
}

async function validateRepositoryReference(
  client: RecoveryClient,
  input: RecoveryLocatorObservation,
): Promise<void> {
  validateObservation(input);
  const repositoryEntityId = input.repositoryEntityId ?? null;
  if (input.identity.entityType === 'repository') {
    if (repositoryEntityId !== null) {
      throw new Error('Repository locator must not reference a repository entity');
    }
    return;
  }
  if (!repositoryEntityId) throw new Error('Issue locator requires a repository entity');
  const result = await query<{ entityType: string; provider: string; hostKey: string }>(
    client,
    `SELECT entity_type AS "entityType", provider, host_key AS "hostKey"
     FROM external_entities WHERE id = $1 LIMIT 1`,
    [repositoryEntityId],
  );
  const repository = result.rows[0];
  if (
    !repository
    || repository.entityType !== 'repository'
    || repository.provider !== input.identity.provider
    || repository.hostKey !== input.identity.hostKey
  ) {
    throw new Error('Issue locator repository entity does not match its provider and host');
  }
}

async function readCurrentLocator(
  client: RecoveryClient,
  entityId: string,
  forUpdate: boolean,
): Promise<RecoveryLocatorRow | null> {
  const result = await query<RecoveryLocatorRow>(
    client,
    `SELECT ${LOCATOR_COLUMNS} FROM external_entity_locators
     WHERE external_entity_id = $1 AND valid_to IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [entityId],
  );
  return result.rows[0] ?? null;
}

export async function evaluateLocatorPreflight(
  client: RecoveryClient,
  input: RecoveryLocatorObservation,
  forUpdate = false,
): Promise<RecoveryLocatorPreflight> {
  const entity = await requireEntity(client, input.entityId, input.identity, forUpdate);
  await validateRepositoryReference(client, input);
  const current = await readCurrentLocator(client, entity.id, forUpdate);
  const locator = mergeLocator(normalizeLocator(input.locator), current);

  if (current && input.observedAt < current.validFrom && !sameLocator(current, locator)) {
    return {
      state: 'collision',
      locator,
      current,
      collisionCategory: 'locator_overlap_or_regression',
      conflictingEntityId: entity.id,
    };
  }
  if (current && sameLocator(current, locator)) {
    return { state: 'unchanged', locator, current };
  }
  const conflict = await query<{ externalEntityId: string }>(
    client,
    `SELECT external_entity_id AS "externalEntityId"
     FROM external_entity_locators
     WHERE provider = $1 AND host_key = $2 AND owner_key = $3 AND repository_key = $4
       AND issue_number IS NOT DISTINCT FROM $5 AND valid_to IS NULL
     LIMIT 1`,
    [
      entity.provider,
      entity.hostKey,
      locator.ownerKey,
      locator.repositoryKey,
      locator.issueNumber,
    ],
  );
  const conflictingEntityId = conflict.rows[0]?.externalEntityId;
  if (conflictingEntityId && conflictingEntityId !== entity.id) {
    return {
      state: 'collision',
      locator,
      current,
      collisionCategory: entity.entityType === 'repository'
        ? 'repository_path_replacement'
        : 'stable_legacy_disagree',
      conflictingEntityId,
    };
  }
  return { state: 'update', locator, current };
}

/**
 * The operator-sourced locator adoption used by repoint, native transfer, and
 * bulk succession. Mirrors the SQLite
 * `observeOperatorExternalEntityLocatorInTransaction` exactly, including the
 * `'operator'` observation source and the `locator_revision` allocation.
 */
export async function observeOperatorLocator(
  client: PoolClient,
  input: RecoveryLocatorObservation,
): Promise<RecoveryLocatorPreflight> {
  const preflight = await evaluateLocatorPreflight(client, input, true);
  if (preflight.state === 'collision') return preflight;
  const entity = await requireEntity(client, input.entityId, input.identity, true);

  if (preflight.state === 'unchanged') {
    if (input.observedAt > preflight.current.lastSeenAt) {
      await query(
        client,
        'UPDATE external_entity_locators SET last_seen_at = $2 WHERE id = $1',
        [preflight.current.id, input.observedAt],
      );
      await query(
        client,
        'UPDATE external_entities SET last_seen_at = GREATEST(last_seen_at, $2) WHERE id = $1',
        [entity.id, input.observedAt],
      );
    }
    return preflight;
  }

  if (preflight.current) {
    await query(
      client,
      'UPDATE external_entity_locators SET valid_to = $2 WHERE id = $1',
      [preflight.current.id, input.observedAt],
    );
  }
  const revision = await query<{ locatorRevision: number }>(
    client,
    `UPDATE external_entities
     SET next_locator_revision = next_locator_revision + 1,
         last_seen_at = GREATEST(last_seen_at, $2)
     WHERE id = $1
     RETURNING next_locator_revision - 1 AS "locatorRevision"`,
    [entity.id, input.observedAt],
  );
  const locatorRevision = revision.rows[0]?.locatorRevision;
  if (!locatorRevision) throw new Error('External entity disappeared during locator update');
  await query(
    client,
    `INSERT INTO external_entity_locators (
       id, external_entity_id, repository_entity_id, provider, host_key,
       owner, repository, owner_key, repository_key, issue_number, api_url,
       web_url, valid_from, valid_to, last_seen_at, observation_source,
       locator_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$13,'operator',$14)`,
    [
      randomUUID(),
      entity.id,
      input.repositoryEntityId ?? null,
      entity.provider,
      entity.hostKey,
      preflight.locator.owner,
      preflight.locator.repository,
      preflight.locator.ownerKey,
      preflight.locator.repositoryKey,
      preflight.locator.issueNumber,
      preflight.locator.apiUrl,
      preflight.locator.webUrl,
      input.observedAt,
      locatorRevision,
    ],
  );
  return preflight;
}

export async function upsertEntity(
  client: PoolClient,
  identity: ExternalEntityIdentity,
  observedAt: string,
): Promise<RecoveryEntityRow> {
  validateIdentity(identity);
  if (!observedAt) throw new Error('External entity observation time is required');
  const result = await query<RecoveryEntityRow>(
    client,
    `INSERT INTO external_entities (
       id, provider, host_key, entity_type, stable_id, identity_version,
       next_locator_revision, first_seen_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$6)
     ON CONFLICT (provider, host_key, entity_type, stable_id)
     DO UPDATE SET last_seen_at = GREATEST(external_entities.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING ${ENTITY_COLUMNS}`,
    [
      randomUUID(),
      identity.provider,
      identity.hostKey,
      identity.entityType,
      identity.stableId,
      observedAt,
    ],
  );
  const entity = result.rows[0];
  if (!entity) throw new Error('Failed to persist external entity');
  return entity;
}

function boundedIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort().slice(0, MAX_COLLISION_IDS);
}

export async function recordCollision(
  client: PoolClient,
  input: {
    connectorInstanceId: string;
    category: string;
    bindingType: 'task' | 'source_list';
    localIds: readonly string[];
    externalEntityIds: readonly string[];
    legacyIdentity?: string;
    observedAt: string;
  },
): Promise<void> {
  const localIds = boundedIds(input.localIds);
  const externalEntityIds = boundedIds(input.externalEntityIds);
  const fingerprint = digestIdentifier(JSON.stringify({
    category: input.category,
    bindingType: input.bindingType,
    localIds,
    externalEntityIds,
  }));
  await query(
    client,
    `INSERT INTO github_identity_collisions (
       id, connector_instance_id, category, fingerprint, binding_type,
       local_ids, external_entity_ids, legacy_identity_digest, state,
       resolution, first_seen_at, last_seen_at, resolved_at, resolved_by
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'open',NULL,$9,$9,NULL,NULL)
     ON CONFLICT (connector_instance_id, category, fingerprint)
     DO UPDATE SET
       local_ids = EXCLUDED.local_ids,
       external_entity_ids = EXCLUDED.external_entity_ids,
       legacy_identity_digest = EXCLUDED.legacy_identity_digest,
       state = 'open',
       resolution = NULL,
       last_seen_at = EXCLUDED.last_seen_at,
       resolved_at = NULL,
       resolved_by = NULL`,
    [
      randomUUID(),
      input.connectorInstanceId,
      input.category,
      fingerprint,
      input.bindingType,
      JSON.stringify(localIds),
      JSON.stringify(externalEntityIds),
      input.legacyIdentity ? digestIdentifier(input.legacyIdentity) : null,
      input.observedAt,
    ],
  );
}

export interface RecoveryConnectorRow {
  id: string;
  type: string;
  enabled: boolean;
  settings: unknown;
  syncedLists: unknown;
  credentials: unknown;
  deletedAt: string | null;
}

export async function readConnectorRow(
  client: RecoveryClient,
  connectorInstanceId: string,
  forUpdate = false,
): Promise<RecoveryConnectorRow | null> {
  const result = await query<RecoveryConnectorRow>(
    client,
    `SELECT id, type, enabled, settings, synced_lists AS "syncedLists",
            credentials, deleted_at AS "deletedAt"
     FROM connector_configs WHERE id = $1 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [connectorInstanceId],
  );
  return result.rows[0] ?? null;
}

export function connectorSnapshot(row: RecoveryConnectorRow) {
  return {
    id: row.id,
    type: row.type,
    enabled: row.enabled,
    settings: asRecord(row.settings),
    syncedLists: asStringArray(row.syncedLists),
    apiOrigin: readApiOrigin(row.settings),
  };
}

export async function readModeRevision(
  client: RecoveryClient,
  connectorInstanceId: string,
): Promise<number> {
  const result = await query<{ modeRevision: number }>(
    client,
    'SELECT mode_revision AS "modeRevision" FROM github_identity_controls WHERE connector_instance_id = $1',
    [connectorInstanceId],
  );
  return result.rows[0]?.modeRevision ?? 0;
}

function canonicalSourceId(
  owner: string,
  repository: string,
  issueNumber: number | null,
): string {
  if (!Number.isSafeInteger(issueNumber) || (issueNumber ?? 0) <= 0) {
    throw new Error('GitHub issue locator requires a positive issue number');
  }
  return `${owner}/${repository}:${issueNumber}`.toLowerCase();
}

export type RecoveryTaskTransferInspection =
  | { binding: GitHubRecoveryTaskTransferBinding }
  | { error: string };

/**
 * Backend-equivalent of `inspectGitHubTaskTransferBinding`: resolves the active
 * stable issue binding for a connector task and proves the task's `source_id`
 * still agrees with its current locator.
 */
export async function inspectTaskTransferBinding(
  client: RecoveryClient,
  connectorInstanceId: string,
  taskId: string,
): Promise<RecoveryTaskTransferInspection> {
  const taskResult = await query<{ id: string; sourceId: string; title: string }>(
    client,
    `SELECT id, source_id AS "sourceId", title FROM tasks
     WHERE id = $1 AND connector_instance_id = $2 AND connector_type = 'github-issues'
     LIMIT 1`,
    [taskId, connectorInstanceId],
  );
  const task = taskResult.rows[0];
  if (!task) return { error: `GitHub task binding was not found: ${taskId}` };

  const bindingResult = await query<{ externalEntityId: string }>(
    client,
    `SELECT external_entity_id AS "externalEntityId" FROM external_entity_bindings
     WHERE connector_instance_id = $1 AND binding_type = 'task' AND local_id = $2
       AND state IN ('shadow', 'active')
     LIMIT 1`,
    [connectorInstanceId, taskId],
  );
  const binding = bindingResult.rows[0];
  if (!binding) return { error: `GitHub task has no active stable binding: ${taskId}` };

  const entityResult = await query<{
    stableId: string;
    hostKey: string;
    provider: string;
    entityType: string;
  }>(
    client,
    `SELECT stable_id AS "stableId", host_key AS "hostKey", provider,
            entity_type AS "entityType"
     FROM external_entities WHERE id = $1 LIMIT 1`,
    [binding.externalEntityId],
  );
  const entity = entityResult.rows[0];
  if (!entity || entity.provider !== 'github' || entity.entityType !== 'issue') {
    return { error: `GitHub task stable binding is not an issue: ${taskId}` };
  }

  const locator = await readCurrentLocator(client, binding.externalEntityId, false);
  if (!locator?.issueNumber || !locator.repositoryEntityId) {
    return { error: `GitHub task stable binding has no current issue locator: ${taskId}` };
  }
  const locatorSourceId = canonicalSourceId(
    locator.owner,
    locator.repository,
    locator.issueNumber,
  );
  if (locatorSourceId !== task.sourceId.toLowerCase()) {
    return { error: `GitHub task source ID disagrees with its stable locator: ${taskId}` };
  }
  return {
    binding: {
      taskId,
      sourceId: task.sourceId,
      title: task.title,
      externalEntityId: binding.externalEntityId,
      stableId: entity.stableId,
      hostKey: entity.hostKey,
      repositoryEntityId: locator.repositoryEntityId,
      locatorSourceId,
    },
  };
}

export async function requireTaskTransferBinding(
  client: RecoveryClient,
  connectorInstanceId: string,
  taskId: string,
): Promise<GitHubRecoveryTaskTransferBinding> {
  const result = await inspectTaskTransferBinding(client, connectorInstanceId, taskId);
  if ('error' in result) throw new Error(result.error);
  return result.binding;
}
