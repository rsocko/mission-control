import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import type {
  ExternalEntityIdentity,
  ExternalEntityKey,
  ExternalEntityLocatorEvidence,
  ExternalEntityLocatorObservation,
  ExternalEntityLocatorObservationResult,
  ExternalEntityLocatorPreflight,
  ExternalEntityLocatorRecord,
  ExternalEntityRecord,
  ExternalEntityUpsert,
  ExternalIdentityCollisionInput,
  ExternalIdentityCollisionRecord,
  ExternalIdentityObservation,
  ExternalIdentityWrite,
  ExternalIdentityWriteResult,
  NormalizedExternalEntityLocator,
} from '@/lib/external-identities/types';
import type {
  ExternalBindingState,
  ExternalEntityType,
  ExternalLocatorSource,
  GitHubCollisionCategory,
} from '@/db/postgres/schema';
import type {
  GitHubAuthorizeSourceWriteResult,
  GitHubAuthorizeTaskWriteResult,
  GitHubBeginWriteCycleResult,
  GitHubBlockWriteResult,
  GitHubFenceTarget,
  GitHubFenceTaskRow,
  GitHubFinalizeWriteResult,
  GitHubIdentityExceptionSnapshot,
  GitHubIdentityPersistence,
  GitHubLinkedSourceLookupRow,
  GitHubLinkedSourcePersistResult,
  GitHubRecordCycleObservationResult,
  GitHubStableLookupRow,
  GitHubWriteFencePersistence,
} from '@/db/persistence/github-identity';

type Client = Pool | PoolClient;

async function query<T>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await client.query(text, [...params]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

class RollbackSignal<R> extends Error {
  constructor(readonly result: R) {
    super('github-identity-rollback');
    this.name = 'RollbackSignal';
  }
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
      if (error instanceof RollbackSignal) return error.result as T;
      throw error;
    }
  } finally {
    client.release();
  }
}

interface IdentityTargetRow {
  role: GitHubFenceTarget['role'];
  entityId: string;
  repositoryEntityId: string | null;
  hostKey: string;
  locatorRevision: number;
  owner: string;
  repository: string;
  issueNumber: number | null;
  bindingRevision: string;
  bindingState: string;
}

interface DbTaskRow {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId: string | null;
  updatedAt: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  effort: number | null;
  dueDate: string | null;
  microStatus: string | null;
  parentId: string | null;
  isChecklistItem: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
}

interface DbSourceListRow {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
}

interface DbLeaseRow {
  id: string;
  token: string;
  connectorInstanceId: string;
  taskId: string;
  operation: string;
  taskVersion: string;
  idempotencyKey: string;
  modeRevision: number;
  writeCycleId: string | null;
  state: string;
  cycleObservedAt: string | null;
  cycleOutcome: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
  expiresAt: string;
}

interface DbWriteCycleRow {
  id: string;
  connectorInstanceId: string;
  jobId: string | null;
  modeRevision: number;
  pendingCandidateCount: number;
  observedRouteCount: number;
  appliedCount: number;
  blockedCount: number;
  failedCount: number;
  unknownCount: number;
  state: string;
  reconciliationState: string;
  startedAt: string;
  completedAt: string | null;
}

interface PrimaryIdentityEntityRow {
  id: string;
  provider: string;
  hostKey: string;
  entityType: ExternalEntityType;
  stableId: string;
  nextLocatorRevision: number;
}

interface PrimaryIdentityLocatorRow extends NormalizedExternalEntityLocator {
  id: string;
  externalEntityId: string;
  repositoryEntityId: string | null;
  validFrom: string;
  validTo: string | null;
  lastSeenAt: string;
  observationSource: string;
  locatorRevision: number;
}

interface PrimaryIdentityBindingRow {
  id: string;
  externalEntityId: string;
  bindingType: 'task' | 'source_list';
  localId: string;
  state: ExternalBindingState;
}

interface PrimaryIdentityObservationEntry {
  key: string;
  observation: ExternalIdentityObservation;
}

interface PrimaryIdentityCollision {
  write: ExternalIdentityWrite;
  category: GitHubCollisionCategory;
  externalEntityIds: readonly string[];
  observedAt: string;
  localIds?: readonly string[];
}

type PrimaryIdentityLocatorPlan =
  | {
      state: 'collision';
      category: GitHubCollisionCategory;
      conflictingEntityId: string;
    }
  | {
      state: 'same';
      current: PrimaryIdentityLocatorRow;
      locator: NormalizedExternalEntityLocator;
      observation: ExternalIdentityObservation;
      repositoryEntityId: string | null;
    }
  | {
      state: 'replace';
      current: PrimaryIdentityLocatorRow | null;
      locator: NormalizedExternalEntityLocator;
      observation: ExternalIdentityObservation;
      repositoryEntityId: string | null;
    };

const MAX_PRIMARY_IDENTITY_BATCH_SIZE = 500;
const MAX_PRIMARY_IDENTITY_COLLISION_IDS = 50;

function digestExternalIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validatePrimaryIdentityWrite(write: ExternalIdentityWrite): void {
  const { target, evidence } = write;
  if (!target.connectorInstanceId || !target.localId || !target.legacyIdentity) {
    throw new Error('External identity binding target is incomplete');
  }
  validatePrimaryIdentityObservation(evidence.entity);
  if (target.bindingType === 'task' && evidence.entity.identity.entityType !== 'issue') {
    throw new Error('Task bindings require issue identity evidence');
  }
  if (
    target.bindingType === 'source_list'
    && evidence.entity.identity.entityType !== 'repository'
  ) {
    throw new Error('Source-list bindings require repository identity evidence');
  }
  if (!evidence.repository) return;
  validatePrimaryIdentityObservation(evidence.repository);
  if (evidence.repository.identity.entityType !== 'repository') {
    throw new Error('Repository evidence must identify a repository entity');
  }
  if (
    evidence.repository.identity.provider !== evidence.entity.identity.provider
    || evidence.repository.identity.hostKey !== evidence.entity.identity.hostKey
  ) {
    throw new Error('Issue and repository evidence must share a provider and host');
  }
}

function validatePrimaryIdentityObservation(observation: ExternalIdentityObservation): void {
  const { identity, locator } = observation;
  if (!identity.provider || !identity.hostKey || !identity.stableId) {
    throw new Error('External entity key is incomplete');
  }
  if (identity.entityType !== 'repository' && identity.entityType !== 'issue') {
    throw new Error('External entity type is invalid');
  }
  if (!locator.owner || !locator.repository) {
    throw new Error('External identity observation is incomplete');
  }
  if (!observation.observedAt) {
    throw new Error('External entity observation time is required');
  }
  if (identity.entityType === 'issue') {
    if (!Number.isSafeInteger(locator.issueNumber) || (locator.issueNumber ?? 0) <= 0) {
      throw new Error('Issue identity observation requires a positive issue number');
    }
  } else if (locator.issueNumber !== undefined) {
    throw new Error('Repository locator must not include an issue number');
  }
}

function normalizePrimaryIdentityLocator(
  observation: ExternalIdentityObservation,
): NormalizedExternalEntityLocator {
  return {
    owner: observation.locator.owner,
    repository: observation.locator.repository,
    ownerKey: observation.locator.owner.toLowerCase(),
    repositoryKey: observation.locator.repository.toLowerCase(),
    issueNumber: observation.locator.issueNumber ?? null,
    apiUrl: observation.locator.apiUrl ?? null,
    webUrl: observation.locator.webUrl ?? null,
  };
}

function primaryIdentityKey(observation: ExternalIdentityObservation): string {
  const { identity } = observation;
  return JSON.stringify([
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
  ]);
}

function primaryIdentityTargetKey(write: ExternalIdentityWrite): string {
  return JSON.stringify([
    write.target.bindingType,
    write.target.localId,
  ]);
}

function primaryIdentityPathKey(observation: ExternalIdentityObservation): string {
  const locator = normalizePrimaryIdentityLocator(observation);
  return JSON.stringify([
    observation.identity.provider,
    observation.identity.hostKey,
    locator.ownerKey,
    locator.repositoryKey,
    locator.issueNumber,
  ]);
}

function primaryIdentityObservationSignature(
  observation: ExternalIdentityObservation,
): string {
  return JSON.stringify({
    locator: normalizePrimaryIdentityLocator(observation),
    observationSource: observation.observationSource,
    observedAt: observation.observedAt,
  });
}

function partitionPrimaryIdentityWrites(
  writes: readonly ExternalIdentityWrite[],
): { fastIndexes: number[]; sequentialIndexes: number[] } {
  const targetIndexes = new Map<string, number[]>();
  const entityIndexes = new Map<string, number[]>();
  const pathEntities = new Map<string, Map<string, number[]>>();
  const observationSignatures = new Map<string, Map<string, number[]>>();

  const pushIndex = (map: Map<string, number[]>, key: string, index: number): void => {
    const indexes = map.get(key) ?? [];
    indexes.push(index);
    map.set(key, indexes);
  };
  for (const [index, write] of writes.entries()) {
    pushIndex(targetIndexes, primaryIdentityTargetKey(write), index);
    pushIndex(entityIndexes, primaryIdentityKey(write.evidence.entity), index);
    for (const observation of [
      ...(write.evidence.repository ? [write.evidence.repository] : []),
      write.evidence.entity,
    ]) {
      const identityKey = primaryIdentityKey(observation);
      const signature = primaryIdentityObservationSignature(observation);
      const signatures = observationSignatures.get(identityKey) ?? new Map<string, number[]>();
      pushIndex(signatures, signature, index);
      observationSignatures.set(identityKey, signatures);

      const pathKey = primaryIdentityPathKey(observation);
      const entities = pathEntities.get(pathKey) ?? new Map<string, number[]>();
      pushIndex(entities, identityKey, index);
      pathEntities.set(pathKey, entities);
    }
  }

  const sequential = new Set<number>();
  for (const indexes of targetIndexes.values()) {
    if (indexes.length > 1) indexes.forEach((index) => sequential.add(index));
  }
  for (const indexes of entityIndexes.values()) {
    if (indexes.length > 1) indexes.forEach((index) => sequential.add(index));
  }
  for (const signatures of observationSignatures.values()) {
    if (signatures.size <= 1) continue;
    for (const indexes of signatures.values()) {
      indexes.forEach((index) => sequential.add(index));
    }
  }
  for (const entities of pathEntities.values()) {
    if (entities.size <= 1) continue;
    for (const indexes of entities.values()) {
      indexes.forEach((index) => sequential.add(index));
    }
  }

  const fastIndexes: number[] = [];
  const sequentialIndexes: number[] = [];
  for (let index = 0; index < writes.length; index++) {
    (sequential.has(index) ? sequentialIndexes : fastIndexes).push(index);
  }
  return { fastIndexes, sequentialIndexes };
}

function primaryIdentityLockKeys(
  connectorInstanceId: string,
  writes: readonly ExternalIdentityWrite[],
): string[] {
  const keys = new Set<string>([`connector:${connectorInstanceId}`]);
  for (const write of writes) {
    for (const observation of [
      ...(write.evidence.repository ? [write.evidence.repository] : []),
      write.evidence.entity,
    ]) {
      const identity = observation.identity;
      const locator = normalizePrimaryIdentityLocator(observation);
      keys.add(JSON.stringify([
        'identity',
        identity.provider,
        identity.hostKey,
        identity.entityType,
        identity.stableId,
      ]));
      keys.add(JSON.stringify([
        'locator',
        identity.provider,
        identity.hostKey,
        locator.ownerKey,
        locator.repositoryKey,
        locator.issueNumber,
      ]));
    }
  }
  return [...keys].sort();
}

function samePrimaryIdentityLocator(
  current: PrimaryIdentityLocatorRow,
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

async function upsertPrimaryIdentityEntity(
  client: PoolClient,
  observation: ExternalIdentityObservation,
): Promise<PrimaryIdentityEntityRow> {
  const result = await query<PrimaryIdentityEntityRow>(
    client,
    `
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id, identity_version,
        next_locator_revision, first_seen_at, last_seen_at
      ) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
      ON CONFLICT (provider, host_key, entity_type, stable_id)
      DO UPDATE SET last_seen_at = GREATEST(
        external_entities.last_seen_at,
        EXCLUDED.last_seen_at
      )
      RETURNING
        id,
        provider,
        host_key AS "hostKey",
        entity_type AS "entityType",
        stable_id AS "stableId",
        next_locator_revision AS "nextLocatorRevision"
    `,
    [
      randomUUID(),
      observation.identity.provider,
      observation.identity.hostKey,
      observation.identity.entityType,
      observation.identity.stableId,
      observation.observedAt,
    ],
  );
  const entity = result.rows[0];
  if (!entity) throw new Error('Failed to persist external entity');
  return entity;
}

async function observePrimaryIdentityLocator(
  client: PoolClient,
  entity: PrimaryIdentityEntityRow,
  observation: ExternalIdentityObservation,
  repositoryEntityId: string | null,
): Promise<
  | { state: 'observed' }
  | {
      state: 'collision';
      category: GitHubCollisionCategory;
      conflictingEntityId: string;
    }
> {
  let locator = normalizePrimaryIdentityLocator(observation);
  const currentResult = await query<PrimaryIdentityLocatorRow>(
    client,
    `
      SELECT
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
      FROM external_entity_locators
      WHERE external_entity_id = $1 AND valid_to IS NULL
      LIMIT 1
      FOR UPDATE
    `,
    [entity.id],
  );
  const current = currentResult.rows[0];
  if (
    current
    && current.owner === locator.owner
    && current.repository === locator.repository
    && current.issueNumber === locator.issueNumber
  ) {
    locator = {
      ...locator,
      apiUrl: locator.apiUrl ?? current.apiUrl,
      webUrl: locator.webUrl ?? current.webUrl,
    };
  }
  if (
    current
    && observation.observedAt < current.validFrom
    && !samePrimaryIdentityLocator(current, locator)
  ) {
    return {
      state: 'collision',
      category: 'locator_overlap_or_regression',
      conflictingEntityId: entity.id,
    };
  }
  if (current && samePrimaryIdentityLocator(current, locator)) {
    if (observation.observedAt > current.lastSeenAt) {
      await query(
        client,
        'UPDATE external_entity_locators SET last_seen_at = $2 WHERE id = $1',
        [current.id, observation.observedAt],
      );
    }
    return { state: 'observed' };
  }

  const pathConflict = await query<{ externalEntityId: string }>(
    client,
    `
      SELECT external_entity_id AS "externalEntityId"
      FROM external_entity_locators
      WHERE provider = $1
        AND host_key = $2
        AND owner_key = $3
        AND repository_key = $4
        AND issue_number IS NOT DISTINCT FROM $5
        AND valid_to IS NULL
      LIMIT 1
    `,
    [
      entity.provider,
      entity.hostKey,
      locator.ownerKey,
      locator.repositoryKey,
      locator.issueNumber,
    ],
  );
  const conflictingEntityId = pathConflict.rows[0]?.externalEntityId;
  if (conflictingEntityId && conflictingEntityId !== entity.id) {
    return {
      state: 'collision',
      category: entity.entityType === 'repository'
        ? 'repository_path_replacement'
        : 'stable_legacy_disagree',
      conflictingEntityId,
    };
  }

  if (current) {
    await query(
      client,
      'UPDATE external_entity_locators SET valid_to = $2 WHERE id = $1',
      [current.id, observation.observedAt],
    );
  }
  const revision = await query<{ locatorRevision: number }>(
    client,
    `
      UPDATE external_entities
      SET
        next_locator_revision = next_locator_revision + 1,
        last_seen_at = GREATEST(last_seen_at, $2)
      WHERE id = $1
      RETURNING next_locator_revision - 1 AS "locatorRevision"
    `,
    [entity.id, observation.observedAt],
  );
  const locatorRevision = revision.rows[0]?.locatorRevision;
  if (!locatorRevision) {
    throw new Error('External entity disappeared during locator update');
  }
  await query(
    client,
    `
      INSERT INTO external_entity_locators (
        id, external_entity_id, repository_entity_id, provider, host_key,
        owner, repository, owner_key, repository_key, issue_number, api_url,
        web_url, valid_from, valid_to, last_seen_at, observation_source,
        locator_revision
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        NULL, $13, $14, $15
      )
    `,
    [
      randomUUID(),
      entity.id,
      repositoryEntityId,
      entity.provider,
      entity.hostKey,
      locator.owner,
      locator.repository,
      locator.ownerKey,
      locator.repositoryKey,
      locator.issueNumber,
      locator.apiUrl,
      locator.webUrl,
      observation.observedAt,
      observation.observationSource,
      locatorRevision,
    ],
  );
  return { state: 'observed' };
}

function boundedPrimaryIdentityCollisionIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort().slice(0, MAX_PRIMARY_IDENTITY_COLLISION_IDS);
}

async function recordPrimaryIdentityCollision(
  client: PoolClient,
  write: ExternalIdentityWrite,
  category: GitHubCollisionCategory,
  externalEntityIds: readonly string[],
  observedAt: string,
  localIds: readonly string[] = [write.target.localId],
): Promise<ExternalIdentityWriteResult> {
  const [result] = await recordPrimaryIdentityCollisionsBatch(client, [{
    write,
    category,
    externalEntityIds,
    observedAt,
    localIds,
  }]);
  return result;
}

async function recordPrimaryIdentityCollisionsBatch(
  client: PoolClient,
  collisions: readonly PrimaryIdentityCollision[],
): Promise<ExternalIdentityWriteResult[]> {
  if (collisions.length === 0) return [];
  const prepared = collisions.map((collision) => {
    const localIds = boundedPrimaryIdentityCollisionIds(
      collision.localIds ?? [collision.write.target.localId],
    );
    const externalEntityIds = boundedPrimaryIdentityCollisionIds(
      collision.externalEntityIds,
    );
    const fingerprint = digestExternalIdentifier(JSON.stringify({
      category: collision.category,
      bindingType: collision.write.target.bindingType,
      localIds,
      externalEntityIds,
    }));
    return {
      ...collision,
      localIds,
      externalEntityIds,
      fingerprint,
      legacyIdentityDigest: digestExternalIdentifier(
        collision.write.target.legacyIdentity,
      ),
    };
  });
  const uniqueCollisions = [...new Map(prepared.map((collision) => [
    JSON.stringify([
      collision.write.target.connectorInstanceId,
      collision.category,
      collision.fingerprint,
    ]),
    collision,
  ])).values()];
  await query(
    client,
    `
      WITH incoming(
        id, connector_instance_id, category, fingerprint, binding_type,
        local_ids, external_entity_ids, legacy_identity_digest, observed_at
      ) AS (
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::text[], $7::text[], $8::text[], $9::text[]
        )
      )
      INSERT INTO github_identity_collisions (
        id, connector_instance_id, category, fingerprint, binding_type,
        local_ids, external_entity_ids, legacy_identity_digest, state,
        resolution, first_seen_at, last_seen_at, resolved_at, resolved_by
      )
      SELECT
        id, connector_instance_id, category, fingerprint, binding_type,
        local_ids::jsonb, external_entity_ids::jsonb, legacy_identity_digest,
        'open', NULL, observed_at, observed_at, NULL, NULL
      FROM incoming
      ON CONFLICT (connector_instance_id, category, fingerprint)
      DO UPDATE SET
        local_ids = EXCLUDED.local_ids,
        external_entity_ids = EXCLUDED.external_entity_ids,
        legacy_identity_digest = EXCLUDED.legacy_identity_digest,
        state = 'open',
        resolution = NULL,
        last_seen_at = EXCLUDED.last_seen_at,
        resolved_at = NULL,
        resolved_by = NULL
    `,
    [
      uniqueCollisions.map(() => randomUUID()),
      uniqueCollisions.map(({ write }) => write.target.connectorInstanceId),
      uniqueCollisions.map(({ category }) => category),
      uniqueCollisions.map(({ fingerprint }) => fingerprint),
      uniqueCollisions.map(({ write }) => write.target.bindingType),
      uniqueCollisions.map(({ localIds }) => JSON.stringify(localIds)),
      uniqueCollisions.map(({ externalEntityIds }) => JSON.stringify(externalEntityIds)),
      uniqueCollisions.map(({ legacyIdentityDigest }) => legacyIdentityDigest),
      uniqueCollisions.map(({ observedAt }) => observedAt),
    ],
  );
  const localMatches = prepared.flatMap((collision) => (
    collision.localIds.map((localId) => ({
      connectorInstanceId: collision.write.target.connectorInstanceId,
      bindingType: collision.write.target.bindingType,
      localId,
      observedAt: collision.observedAt,
    }))
  ));
  const entityMatches = prepared.flatMap((collision) => (
    collision.externalEntityIds.map((externalEntityId) => ({
      connectorInstanceId: collision.write.target.connectorInstanceId,
      externalEntityId,
      observedAt: collision.observedAt,
    }))
  ));
  await query(
    client,
    `
      WITH local_matches(
        connector_instance_id, binding_type, local_id, observed_at
      ) AS (
        SELECT *
        FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
      ),
      entity_matches(
        connector_instance_id, external_entity_id, observed_at
      ) AS (
        SELECT *
        FROM unnest($5::text[], $6::text[], $7::text[])
      ),
      matched_bindings AS (
        SELECT matches.id, max(matches.observed_at) AS observed_at
        FROM (
          SELECT binding.id, local_matches.observed_at
          FROM external_entity_bindings binding
          INNER JOIN local_matches
            ON local_matches.connector_instance_id = binding.connector_instance_id
           AND local_matches.binding_type = binding.binding_type
           AND local_matches.local_id = binding.local_id
          WHERE binding.state != 'retired'
          UNION ALL
          SELECT binding.id, entity_matches.observed_at
          FROM external_entity_bindings binding
          INNER JOIN entity_matches
            ON entity_matches.connector_instance_id = binding.connector_instance_id
           AND entity_matches.external_entity_id = binding.external_entity_id
          WHERE binding.state != 'retired'
        ) matches
        GROUP BY matches.id
      )
      UPDATE external_entity_bindings
      SET
        state = 'collision',
        updated_at = matched_bindings.observed_at
      FROM matched_bindings
      WHERE external_entity_bindings.id = matched_bindings.id
    `,
    [
      localMatches.map(({ connectorInstanceId }) => connectorInstanceId),
      localMatches.map(({ bindingType }) => bindingType),
      localMatches.map(({ localId }) => localId),
      localMatches.map(({ observedAt }) => observedAt),
      entityMatches.map(({ connectorInstanceId }) => connectorInstanceId),
      entityMatches.map(({ externalEntityId }) => externalEntityId),
      entityMatches.map(({ observedAt }) => observedAt),
    ],
  );
  return prepared.map(({ write, category }) => ({
    target: write.target,
    state: 'collision',
    collisionCategory: category,
  }));
}

async function persistPrimaryIdentityWrite(
  client: PoolClient,
  write: ExternalIdentityWrite,
): Promise<ExternalIdentityWriteResult> {
  const { evidence, target } = write;
  let repositoryEntity: PrimaryIdentityEntityRow | null = null;
  if (evidence.entity.identity.entityType === 'issue') {
    if (!evidence.repository) {
      throw new Error('Issue identity evidence requires a repository observation');
    }
    repositoryEntity = await upsertPrimaryIdentityEntity(client, evidence.repository);
    const repositoryLocator = await observePrimaryIdentityLocator(
      client,
      repositoryEntity,
      evidence.repository,
      null,
    );
    if (repositoryLocator.state === 'collision') {
      return recordPrimaryIdentityCollision(
        client,
        write,
        repositoryLocator.category,
        [repositoryEntity.id, repositoryLocator.conflictingEntityId],
        evidence.repository.observedAt,
      );
    }
  }

  const entity = await upsertPrimaryIdentityEntity(client, evidence.entity);
  const localBindingResult = await query<PrimaryIdentityBindingRow>(
    client,
    `
      SELECT
        id,
        external_entity_id AS "externalEntityId",
        binding_type AS "bindingType",
        local_id AS "localId",
        state
      FROM external_entity_bindings
      WHERE connector_instance_id = $1
        AND binding_type = $2
        AND local_id = $3
      LIMIT 1
      FOR UPDATE
    `,
    [target.connectorInstanceId, target.bindingType, target.localId],
  );
  const entityBindingResult = await query<PrimaryIdentityBindingRow>(
    client,
    `
      SELECT
        id,
        external_entity_id AS "externalEntityId",
        binding_type AS "bindingType",
        local_id AS "localId",
        state
      FROM external_entity_bindings
      WHERE connector_instance_id = $1
        AND external_entity_id = $2
      LIMIT 1
      FOR UPDATE
    `,
    [target.connectorInstanceId, entity.id],
  );
  const localBinding = localBindingResult.rows[0];
  const entityBinding = entityBindingResult.rows[0];
  if (localBinding && localBinding.externalEntityId !== entity.id) {
    return recordPrimaryIdentityCollision(
      client,
      write,
      'one_local_multiple_stable',
      [localBinding.externalEntityId, entity.id],
      evidence.entity.observedAt,
    );
  }
  if (
    entityBinding
    && (
      entityBinding.bindingType !== target.bindingType
      || entityBinding.localId !== target.localId
    )
  ) {
    return recordPrimaryIdentityCollision(
      client,
      write,
      'multiple_local_one_stable',
      [entity.id],
      evidence.entity.observedAt,
      [entityBinding.localId, target.localId],
    );
  }
  if (localBinding?.state === 'retired' || entityBinding?.state === 'retired') {
    return recordPrimaryIdentityCollision(
      client,
      write,
      'stable_legacy_disagree',
      [entity.id],
      evidence.entity.observedAt,
    );
  }

  const locator = await observePrimaryIdentityLocator(
    client,
    entity,
    evidence.entity,
    repositoryEntity?.id ?? null,
  );
  if (locator.state === 'collision') {
    return recordPrimaryIdentityCollision(
      client,
      write,
      locator.category,
      [entity.id, locator.conflictingEntityId],
      evidence.entity.observedAt,
    );
  }

  const existingBinding = localBinding ?? entityBinding;
  if (existingBinding) {
    await query(
      client,
      `
        UPDATE external_entity_bindings
        SET verified_at = $2, updated_at = $2
        WHERE id = $1
      `,
      [existingBinding.id, evidence.entity.observedAt],
    );
  } else {
    await query(
      client,
      `
        INSERT INTO external_entity_bindings (
          id, external_entity_id, connector_instance_id, binding_type, local_id,
          state, verified_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6)
      `,
      [
        randomUUID(),
        entity.id,
        target.connectorInstanceId,
        target.bindingType,
        target.localId,
        evidence.entity.observedAt,
      ],
    );
  }
  return { target, state: 'bound', externalEntityId: entity.id };
}

function planPrimaryIdentityLocator(
  observation: ExternalIdentityObservation,
  entity: PrimaryIdentityEntityRow,
  repositoryEntityId: string | null,
  current: PrimaryIdentityLocatorRow | null,
  pathOwnerEntityId: string | null,
): PrimaryIdentityLocatorPlan {
  const normalized = normalizePrimaryIdentityLocator(observation);
  const locator = current
    && current.owner === normalized.owner
    && current.repository === normalized.repository
    && current.issueNumber === normalized.issueNumber
    ? {
        ...normalized,
        apiUrl: normalized.apiUrl ?? current.apiUrl,
        webUrl: normalized.webUrl ?? current.webUrl,
      }
    : normalized;
  if (
    current
    && observation.observedAt < current.validFrom
    && !samePrimaryIdentityLocator(current, locator)
  ) {
    return {
      state: 'collision',
      category: 'locator_overlap_or_regression',
      conflictingEntityId: current.externalEntityId,
    };
  }
  if (current && samePrimaryIdentityLocator(current, locator)) {
    return {
      state: 'same',
      current,
      locator,
      observation,
      repositoryEntityId,
    };
  }
  if (pathOwnerEntityId && pathOwnerEntityId !== entity.id) {
    return {
      state: 'collision',
      category: observation.identity.entityType === 'repository'
        ? 'repository_path_replacement'
        : 'stable_legacy_disagree',
      conflictingEntityId: pathOwnerEntityId,
    };
  }
  return {
    state: 'replace',
    current,
    locator,
    observation,
    repositoryEntityId,
  };
}

async function upsertPrimaryIdentityEntitiesBatch(
  client: PoolClient,
  observations: readonly PrimaryIdentityObservationEntry[],
): Promise<Map<string, PrimaryIdentityEntityRow>> {
  const result = await query<PrimaryIdentityEntityRow>(
    client,
    `
      WITH incoming(
        id, provider, host_key, entity_type, stable_id, observed_at
      ) AS (
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[],
          $4::text[], $5::text[], $6::text[]
        )
      )
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id,
        identity_version, next_locator_revision, first_seen_at, last_seen_at
      )
      SELECT
        id, provider, host_key, entity_type, stable_id,
        1, 1, observed_at, observed_at
      FROM incoming
      ON CONFLICT (provider, host_key, entity_type, stable_id)
      DO UPDATE SET
        last_seen_at = GREATEST(external_entities.last_seen_at, EXCLUDED.last_seen_at)
      RETURNING
        id,
        provider,
        host_key AS "hostKey",
        entity_type AS "entityType",
        stable_id AS "stableId",
        next_locator_revision AS "nextLocatorRevision",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt"
    `,
    [
      observations.map(() => randomUUID()),
      observations.map(({ observation }) => observation.identity.provider),
      observations.map(({ observation }) => observation.identity.hostKey),
      observations.map(({ observation }) => observation.identity.entityType),
      observations.map(({ observation }) => observation.identity.stableId),
      observations.map(({ observation }) => observation.observedAt),
    ],
  );
  return new Map(result.rows.map((entity) => [
    JSON.stringify([entity.provider, entity.hostKey, entity.entityType, entity.stableId]),
    entity,
  ]));
}

async function loadPrimaryIdentityCurrentLocatorsBatch(
  client: PoolClient,
  entityIds: readonly string[],
): Promise<Map<string, PrimaryIdentityLocatorRow>> {
  const result = await query<PrimaryIdentityLocatorRow>(
    client,
    `
      SELECT
        id,
        external_entity_id AS "externalEntityId",
        repository_entity_id AS "repositoryEntityId",
        provider,
        host_key AS "hostKey",
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
      FROM external_entity_locators
      WHERE external_entity_id = ANY($1::text[])
        AND valid_to IS NULL
      FOR UPDATE
    `,
    [entityIds],
  );
  return new Map(result.rows.map((locator) => [locator.externalEntityId, locator]));
}

async function loadPrimaryIdentityPathOwnersBatch(
  client: PoolClient,
  observations: readonly PrimaryIdentityObservationEntry[],
): Promise<Map<string, { externalEntityId: string; identityKey: string }>> {
  const locators = observations.map(({ observation }) => (
    normalizePrimaryIdentityLocator(observation)
  ));
  const result = await query<{
    pathKey: string;
    externalEntityId: string;
    provider: string;
    hostKey: string;
    entityType: ExternalEntityType;
    stableId: string;
  }>(
    client,
    `
      WITH incoming(
        path_key, provider, host_key, owner_key, repository_key, issue_number
      ) AS (
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[],
          $4::text[], $5::text[], $6::integer[]
        )
      )
      SELECT
        incoming.path_key AS "pathKey",
        locator.external_entity_id AS "externalEntityId",
        entity.provider,
        entity.host_key AS "hostKey",
        entity.entity_type AS "entityType",
        entity.stable_id AS "stableId"
      FROM incoming
      INNER JOIN external_entity_locators locator
        ON locator.provider = incoming.provider
       AND locator.host_key = incoming.host_key
       AND locator.owner_key = incoming.owner_key
       AND locator.repository_key = incoming.repository_key
       AND locator.issue_number IS NOT DISTINCT FROM incoming.issue_number
       AND locator.valid_to IS NULL
      INNER JOIN external_entities entity
        ON entity.id = locator.external_entity_id
    `,
    [
      observations.map(({ observation }) => primaryIdentityPathKey(observation)),
      observations.map(({ observation }) => observation.identity.provider),
      observations.map(({ observation }) => observation.identity.hostKey),
      locators.map((locator) => locator.ownerKey),
      locators.map((locator) => locator.repositoryKey),
      locators.map((locator) => locator.issueNumber),
    ],
  );
  return new Map(result.rows.map((row) => [
    row.pathKey,
    {
      externalEntityId: row.externalEntityId,
      identityKey: JSON.stringify([
        row.provider,
        row.hostKey,
        row.entityType,
        row.stableId,
      ]),
    },
  ]));
}

async function loadPrimaryIdentityBindingsBatch(
  client: PoolClient,
  connectorInstanceId: string,
  writes: readonly ExternalIdentityWrite[],
  entityIds: readonly string[],
): Promise<{
  byEntity: Map<string, PrimaryIdentityBindingRow>;
  byTarget: Map<string, PrimaryIdentityBindingRow>;
}> {
  const result = await query<PrimaryIdentityBindingRow>(
    client,
    `
      WITH targets(binding_type, local_id) AS (
        SELECT *
        FROM unnest($3::text[], $4::text[])
      )
      SELECT
        binding.id,
        binding.external_entity_id AS "externalEntityId",
        binding.binding_type AS "bindingType",
        binding.local_id AS "localId",
        binding.state
      FROM external_entity_bindings binding
      WHERE binding.connector_instance_id = $1
        AND (
          binding.external_entity_id = ANY($2::text[])
          OR EXISTS (
            SELECT 1
            FROM targets
            WHERE targets.binding_type = binding.binding_type
              AND targets.local_id = binding.local_id
          )
        )
      FOR UPDATE
    `,
    [
      connectorInstanceId,
      entityIds,
      writes.map((write) => write.target.bindingType),
      writes.map((write) => write.target.localId),
    ],
  );
  return {
    byEntity: new Map(result.rows.map((binding) => [binding.externalEntityId, binding])),
    byTarget: new Map(result.rows.map((binding) => [
      JSON.stringify([binding.bindingType, binding.localId]),
      binding,
    ])),
  };
}

async function applyPrimaryIdentityLocatorPlansBatch(
  client: PoolClient,
  plans: readonly Exclude<PrimaryIdentityLocatorPlan, { state: 'collision' }>[],
  entities: ReadonlyMap<string, PrimaryIdentityEntityRow>,
): Promise<void> {
  const same = plans.filter((plan) => (
    plan.state === 'same' && plan.observation.observedAt > plan.current.lastSeenAt
  ));
  if (same.length > 0) {
    await query(
      client,
      `
        WITH incoming(external_entity_id, observed_at) AS (
          SELECT *
          FROM unnest($1::text[], $2::text[])
        )
        UPDATE external_entity_locators locator
        SET last_seen_at = incoming.observed_at
        FROM incoming
        WHERE locator.external_entity_id = incoming.external_entity_id
          AND locator.valid_to IS NULL
          AND locator.last_seen_at < incoming.observed_at
      `,
      [
        same.map((plan) => entities.get(primaryIdentityKey(plan.observation))!.id),
        same.map((plan) => plan.observation.observedAt),
      ],
    );
  }

  const replacements = plans.filter((plan) => plan.state === 'replace');
  const replacementsWithCurrent = replacements.filter((plan) => plan.current !== null);
  if (replacementsWithCurrent.length > 0) {
    await query(
      client,
      `
        WITH incoming(external_entity_id, observed_at) AS (
          SELECT *
          FROM unnest($1::text[], $2::text[])
        )
        UPDATE external_entity_locators locator
        SET valid_to = incoming.observed_at
        FROM incoming
        WHERE locator.external_entity_id = incoming.external_entity_id
          AND locator.valid_to IS NULL
      `,
      [
        replacementsWithCurrent.map((plan) => (
          entities.get(primaryIdentityKey(plan.observation))!.id
        )),
        replacementsWithCurrent.map((plan) => plan.observation.observedAt),
      ],
    );
  }
  if (replacements.length === 0) return;

  const replacementEntities = replacements.map((plan) => (
    entities.get(primaryIdentityKey(plan.observation))!
  ));
  await query(
    client,
    `
      WITH incoming(
        id, external_entity_id, repository_entity_id, provider, host_key,
        owner, repository, owner_key, repository_key, issue_number,
        api_url, web_url, observed_at, observation_source
      ) AS (
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[],
          $5::text[], $6::text[], $7::text[], $8::text[],
          $9::text[], $10::integer[], $11::text[], $12::text[],
          $13::text[], $14::text[]
        )
      ),
      revisions AS (
        UPDATE external_entities entity
        SET next_locator_revision = entity.next_locator_revision + 1
        FROM incoming
        WHERE entity.id = incoming.external_entity_id
        RETURNING
          entity.id AS external_entity_id,
          entity.next_locator_revision - 1 AS locator_revision
      )
      INSERT INTO external_entity_locators (
        id, external_entity_id, repository_entity_id, provider, host_key,
        owner, repository, owner_key, repository_key, issue_number,
        api_url, web_url, valid_from, valid_to, last_seen_at,
        observation_source, locator_revision
      )
      SELECT
        incoming.id,
        incoming.external_entity_id,
        incoming.repository_entity_id,
        incoming.provider,
        incoming.host_key,
        incoming.owner,
        incoming.repository,
        incoming.owner_key,
        incoming.repository_key,
        incoming.issue_number,
        incoming.api_url,
        incoming.web_url,
        incoming.observed_at,
        NULL,
        incoming.observed_at,
        incoming.observation_source,
        revisions.locator_revision
      FROM incoming
      INNER JOIN revisions
        ON revisions.external_entity_id = incoming.external_entity_id
    `,
    [
      replacements.map(() => randomUUID()),
      replacementEntities.map((entity) => entity.id),
      replacements.map((plan) => plan.repositoryEntityId),
      replacements.map((plan) => plan.observation.identity.provider),
      replacements.map((plan) => plan.observation.identity.hostKey),
      replacements.map((plan) => plan.locator.owner),
      replacements.map((plan) => plan.locator.repository),
      replacements.map((plan) => plan.locator.ownerKey),
      replacements.map((plan) => plan.locator.repositoryKey),
      replacements.map((plan) => plan.locator.issueNumber),
      replacements.map((plan) => plan.locator.apiUrl),
      replacements.map((plan) => plan.locator.webUrl),
      replacements.map((plan) => plan.observation.observedAt),
      replacements.map((plan) => plan.observation.observationSource),
    ],
  );
}

async function applyPrimaryIdentityBindingsBatch(
  client: PoolClient,
  connectorInstanceId: string,
  bindings: readonly {
    existing: PrimaryIdentityBindingRow | null;
    entityId: string;
    write: ExternalIdentityWrite;
  }[],
): Promise<void> {
  const existing = bindings.filter((binding) => binding.existing !== null);
  if (existing.length > 0) {
    await query(
      client,
      `
        WITH incoming(id, observed_at) AS (
          SELECT *
          FROM unnest($1::text[], $2::text[])
        )
        UPDATE external_entity_bindings binding
        SET
          verified_at = incoming.observed_at,
          updated_at = incoming.observed_at
        FROM incoming
        WHERE binding.id = incoming.id
      `,
      [
        existing.map((binding) => binding.existing!.id),
        existing.map((binding) => binding.write.evidence.entity.observedAt),
      ],
    );
  }

  const inserted = bindings.filter((binding) => binding.existing === null);
  if (inserted.length === 0) return;
  await query(
    client,
    `
      WITH incoming(
        id, external_entity_id, binding_type, local_id, observed_at
      ) AS (
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[]
        )
      )
      INSERT INTO external_entity_bindings (
        id, external_entity_id, connector_instance_id, binding_type,
        local_id, state, verified_at, created_at, updated_at
      )
      SELECT
        incoming.id,
        incoming.external_entity_id,
        $6,
        incoming.binding_type,
        incoming.local_id,
        'active',
        incoming.observed_at,
        incoming.observed_at,
        incoming.observed_at
      FROM incoming
    `,
    [
      inserted.map(() => randomUUID()),
      inserted.map((binding) => binding.entityId),
      inserted.map((binding) => binding.write.target.bindingType),
      inserted.map((binding) => binding.write.target.localId),
      inserted.map((binding) => binding.write.evidence.entity.observedAt),
      connectorInstanceId,
    ],
  );
}

async function persistPrimaryIdentityFastBatch(
  client: PoolClient,
  writes: readonly ExternalIdentityWrite[],
  indexes: readonly number[],
  results: Array<ExternalIdentityWriteResult | undefined>,
): Promise<void> {
  if (indexes.length === 0) return;

  const observationsByKey = new Map<string, PrimaryIdentityObservationEntry>();
  const repositoryKeysByEntityKey = new Map<string, string>();
  for (const index of indexes) {
    const write = writes[index];
    if (write.evidence.repository) {
      repositoryKeysByEntityKey.set(
        primaryIdentityKey(write.evidence.entity),
        primaryIdentityKey(write.evidence.repository),
      );
    }
    for (const observation of [
      ...(write.evidence.repository ? [write.evidence.repository] : []),
      write.evidence.entity,
    ]) {
      const key = primaryIdentityKey(observation);
      const existing = observationsByKey.get(key);
      if (!existing || observation.observedAt > existing.observation.observedAt) {
        observationsByKey.set(key, { key, observation });
      }
    }
  }
  const observations = [...observationsByKey.values()];
  const pathOwners = await loadPrimaryIdentityPathOwnersBatch(client, observations);
  const hasOrderedPathDependency = observations.some((entry) => {
    const pathKey = primaryIdentityPathKey(entry.observation);
    const owner = pathOwners.get(pathKey);
    if (!owner || owner.identityKey === entry.key) return false;
    const ownerObservation = observationsByKey.get(owner.identityKey);
    return ownerObservation
      ? primaryIdentityPathKey(ownerObservation.observation) !== pathKey
      : false;
  });
  if (hasOrderedPathDependency) {
    for (const index of indexes) {
      results[index] = await persistPrimaryIdentityWrite(client, writes[index]);
    }
    return;
  }

  const repositoryObservations = observations.filter(({ observation }) => (
    observation.identity.entityType === 'repository'
  ));
  const entities = await upsertPrimaryIdentityEntitiesBatch(client, repositoryObservations);
  const currentLocators = await loadPrimaryIdentityCurrentLocatorsBatch(
    client,
    [...entities.values()].map((entity) => entity.id),
  );
  const locatorPlans = new Map<string, PrimaryIdentityLocatorPlan>();
  for (const entry of repositoryObservations) {
    const entity = entities.get(entry.key)!;
    locatorPlans.set(entry.key, planPrimaryIdentityLocator(
      entry.observation,
      entity,
      null,
      currentLocators.get(entity.id) ?? null,
      pathOwners.get(primaryIdentityPathKey(entry.observation))?.externalEntityId ?? null,
    ));
  }

  const repositoryCollisionEntityKeys = new Set(indexes.flatMap((index) => {
    const write = writes[index];
    if (!write.evidence.repository) return [];
    const repositoryPlan = locatorPlans.get(primaryIdentityKey(write.evidence.repository))!;
    return repositoryPlan.state === 'collision'
      ? [primaryIdentityKey(write.evidence.entity)]
      : [];
  }));
  const issueObservations = observations.filter(({ key, observation }) => (
    observation.identity.entityType === 'issue'
    && !repositoryCollisionEntityKeys.has(key)
  ));
  if (issueObservations.length > 0) {
    const issueEntities = await upsertPrimaryIdentityEntitiesBatch(client, issueObservations);
    for (const [key, entity] of issueEntities) entities.set(key, entity);
    const issueLocators = await loadPrimaryIdentityCurrentLocatorsBatch(
      client,
      [...issueEntities.values()].map((entity) => entity.id),
    );
    for (const [entityId, locator] of issueLocators) {
      currentLocators.set(entityId, locator);
    }
    for (const entry of issueObservations) {
      const entity = entities.get(entry.key)!;
      const repositoryKey = repositoryKeysByEntityKey.get(entry.key)!;
      locatorPlans.set(entry.key, planPrimaryIdentityLocator(
        entry.observation,
        entity,
        entities.get(repositoryKey)!.id,
        currentLocators.get(entity.id) ?? null,
        pathOwners.get(primaryIdentityPathKey(entry.observation))?.externalEntityId ?? null,
      ));
    }
  }

  const bindingIndexes = indexes.filter((index) => (
    !repositoryCollisionEntityKeys.has(primaryIdentityKey(writes[index].evidence.entity))
  ));
  const bindingWrites = bindingIndexes.map((index) => writes[index]);
  const primaryEntityIds = bindingWrites.map((write) => (
    entities.get(primaryIdentityKey(write.evidence.entity))!.id
  ));
  const connectorInstanceId = writes[indexes[0]].target.connectorInstanceId;
  const bindings = bindingWrites.length > 0
    ? await loadPrimaryIdentityBindingsBatch(
        client,
        connectorInstanceId,
        bindingWrites,
        primaryEntityIds,
      )
    : {
        byEntity: new Map<string, PrimaryIdentityBindingRow>(),
        byTarget: new Map<string, PrimaryIdentityBindingRow>(),
      };
  const locatorPlansToApply = new Map<string, Exclude<
    PrimaryIdentityLocatorPlan,
    { state: 'collision' }
  >>();
  const bindingsToApply: Array<{
    existing: PrimaryIdentityBindingRow | null;
    entityId: string;
    write: ExternalIdentityWrite;
  }> = [];
  const collisions: Array<PrimaryIdentityCollision & {
    index: number;
  }> = [];

  for (const index of indexes) {
    const write = writes[index];
    const entityKey = primaryIdentityKey(write.evidence.entity);
    const repositoryKey = write.evidence.repository
      ? primaryIdentityKey(write.evidence.repository)
      : null;
    const repositoryPlan = repositoryKey ? locatorPlans.get(repositoryKey)! : null;
    if (repositoryPlan?.state === 'collision') {
      collisions.push({
        index,
        write,
        category: repositoryPlan.category,
        externalEntityIds: [
          entities.get(repositoryKey!)!.id,
          repositoryPlan.conflictingEntityId,
        ],
        observedAt: write.evidence.repository!.observedAt,
      });
      continue;
    }

    const entity = entities.get(entityKey)!;
    const localBinding = bindings.byTarget.get(primaryIdentityTargetKey(write));
    const entityBinding = bindings.byEntity.get(entity.id);
    if (localBinding && localBinding.externalEntityId !== entity.id) {
      if (repositoryKey) locatorPlansToApply.set(repositoryKey, repositoryPlan!);
      collisions.push({
        index,
        write,
        category: 'one_local_multiple_stable',
        externalEntityIds: [localBinding.externalEntityId, entity.id],
        observedAt: write.evidence.entity.observedAt,
      });
      continue;
    }
    if (
      entityBinding
      && (
        entityBinding.bindingType !== write.target.bindingType
        || entityBinding.localId !== write.target.localId
      )
    ) {
      if (repositoryKey) locatorPlansToApply.set(repositoryKey, repositoryPlan!);
      collisions.push({
        index,
        write,
        category: 'multiple_local_one_stable',
        externalEntityIds: [entity.id],
        localIds: [entityBinding.localId, write.target.localId],
        observedAt: write.evidence.entity.observedAt,
      });
      continue;
    }
    if (localBinding?.state === 'retired' || entityBinding?.state === 'retired') {
      if (repositoryKey) locatorPlansToApply.set(repositoryKey, repositoryPlan!);
      collisions.push({
        index,
        write,
        category: 'stable_legacy_disagree',
        externalEntityIds: [entity.id],
        observedAt: write.evidence.entity.observedAt,
      });
      continue;
    }

    const entityPlan = locatorPlans.get(entityKey)!;
    if (entityPlan.state === 'collision') {
      if (repositoryKey) locatorPlansToApply.set(repositoryKey, repositoryPlan!);
      collisions.push({
        index,
        write,
        category: entityPlan.category,
        externalEntityIds: [entity.id, entityPlan.conflictingEntityId],
        observedAt: write.evidence.entity.observedAt,
      });
      continue;
    }

    if (repositoryKey) locatorPlansToApply.set(repositoryKey, repositoryPlan!);
    locatorPlansToApply.set(entityKey, entityPlan);
    bindingsToApply.push({
      existing: localBinding ?? entityBinding ?? null,
      entityId: entity.id,
      write,
    });
    results[index] = {
      target: write.target,
      state: 'bound',
      externalEntityId: entity.id,
    };
  }

  await applyPrimaryIdentityLocatorPlansBatch(
    client,
    [...locatorPlansToApply.values()],
    entities,
  );
  await applyPrimaryIdentityBindingsBatch(client, connectorInstanceId, bindingsToApply);
  const collisionResults = await recordPrimaryIdentityCollisionsBatch(client, collisions);
  for (const [collisionIndex, collision] of collisions.entries()) {
    results[collision.index] = collisionResults[collisionIndex];
  }
}

const TASK_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  source_id AS "sourceId",
  source_list_id AS "sourceListId",
  updated_at AS "updatedAt",
  title,
  description,
  status,
  priority,
  effort,
  due_date AS "dueDate",
  micro_status AS "microStatus",
  parent_id AS "parentId",
  is_checklist_item AS "isChecklistItem",
  sync_status AS "syncStatus",
  last_synced_at AS "lastSyncedAt"
`;

const LEASE_COLUMNS = `
  id,
  token,
  connector_instance_id AS "connectorInstanceId",
  task_id AS "taskId",
  operation,
  task_version AS "taskVersion",
  idempotency_key AS "idempotencyKey",
  mode_revision AS "modeRevision",
  write_cycle_id AS "writeCycleId",
  state,
  cycle_observed_at AS "cycleObservedAt",
  cycle_outcome AS "cycleOutcome",
  dispatched_at AS "dispatchedAt",
  finalized_at AS "finalizedAt",
  expires_at AS "expiresAt"
`;

const WRITE_CYCLE_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  job_id AS "jobId",
  mode_revision AS "modeRevision",
  pending_candidate_count AS "pendingCandidateCount",
  observed_route_count AS "observedRouteCount",
  applied_count AS "appliedCount",
  blocked_count AS "blockedCount",
  failed_count AS "failedCount",
  unknown_count AS "unknownCount",
  state,
  reconciliation_state AS "reconciliationState",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`;

function digestLocator(...values: Array<string | number | null>): string {
  return createHash('sha256')
    .update(values.map((value) => value ?? '').join('\u0000'))
    .digest('hex');
}

export function createPostgresGitHubIdentityRepositories(
  pool: Pool,
): { identity: GitHubIdentityPersistence; writeFence: GitHubWriteFencePersistence } {
  async function readModeRevision(client: Client, connectorInstanceId: string): Promise<number> {
    const { rows } = await query<{ modeRevision: number }>(
      client,
      `
        SELECT mode_revision AS "modeRevision"
        FROM github_identity_controls
        WHERE connector_instance_id = $1
        LIMIT 1
      `,
      [connectorInstanceId],
    );
    return rows[0]?.modeRevision ?? 0;
  }

  async function readModeRevisionForShare(
    client: PoolClient,
    connectorInstanceId: string,
  ): Promise<number | null> {
    const { rows } = await query<{ modeRevision: number }>(
      client,
      `
        SELECT mode_revision AS "modeRevision"
        FROM github_identity_controls
        WHERE connector_instance_id = $1
        FOR SHARE
      `,
      [connectorInstanceId],
    );
    return rows[0]?.modeRevision ?? null;
  }

  async function identityForBinding(
    client: Client,
    connectorId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
    role: GitHubFenceTarget['role'],
  ): Promise<IdentityTargetRow | null> {
    const { rows } = await query<Omit<IdentityTargetRow, 'role'>>(
      client,
      `
        SELECT
          entity.id AS "entityId",
          entity.host_key AS "hostKey",
          locator.repository_entity_id AS "repositoryEntityId",
          locator.locator_revision AS "locatorRevision",
          locator.owner,
          locator.repository,
          locator.issue_number AS "issueNumber",
          binding.state AS "bindingState",
          binding.verified_at AS "bindingRevision"
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        JOIN external_entity_locators AS locator
          ON locator.external_entity_id = entity.id
          AND locator.valid_to IS NULL
        WHERE binding.connector_instance_id = $1
          AND binding.binding_type = $2
          AND binding.local_id = $3
          AND binding.state IN ('shadow', 'active')
          AND binding.verified_at IS NOT NULL
          AND entity.provider = 'github'
        LIMIT 1
      `,
      [connectorId, bindingType, localId],
    );
    const row = rows[0];
    if (!row || !['shadow', 'active'].includes(row.bindingState) || !row.bindingRevision) {
      return null;
    }
    return { role, ...row };
  }

  async function repositoryForIssue(
    client: Client,
    issue: IdentityTargetRow,
    role: GitHubFenceTarget['role'],
  ): Promise<IdentityTargetRow | null> {
    if (!issue.repositoryEntityId) return null;
    const { rows } = await query<{
      entityId: string;
      hostKey: string;
      locatorRevision: number;
      owner: string;
      repository: string;
    }>(
      client,
      `
        SELECT
          entity.id AS "entityId",
          entity.host_key AS "hostKey",
          locator.locator_revision AS "locatorRevision",
          locator.owner,
          locator.repository
        FROM external_entities AS entity
        JOIN external_entity_locators AS locator
          ON locator.external_entity_id = entity.id
          AND locator.valid_to IS NULL
        WHERE entity.id = $1
          AND entity.provider = 'github'
          AND entity.entity_type = 'repository'
        LIMIT 1
      `,
      [issue.repositoryEntityId],
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          role,
          repositoryEntityId: null,
          issueNumber: null,
          bindingRevision: '',
          bindingState: issue.bindingState,
        }
      : null;
  }

  async function resolveLocalSourceListId(
    client: Client,
    connectorId: string,
    sourceListId: string,
  ): Promise<string | null> {
    const { rows } = await query<{ id: string }>(
      client,
      `
        SELECT id
        FROM source_lists
        WHERE connector_instance_id = $1
          AND (id = $2 OR lower(source_id) = lower($2))
        ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [connectorId, sourceListId],
    );
    return rows[0]?.id ?? null;
  }

  async function loadTargets(
    client: Client,
    connectorId: string,
    taskId: string,
    sourceListId: string | null,
    sourceId: string,
    operation: string,
    targetSourceListId?: string | null,
    participants?: readonly { role: 'parent_issue' | 'blocker_issue' | 'blocked_issue'; taskId: string }[],
  ): Promise<IdentityTargetRow[] | null> {
    const result: IdentityTargetRow[] = [];
    const localCreation = sourceId.startsWith('local:') || sourceId === taskId;
    const issue = localCreation
      ? null
      : await identityForBinding(client, connectorId, 'task', taskId, 'primary_issue');
    if (!localCreation && !issue) return null;
    if (issue) result.push(issue);
    const localSourceListId = sourceListId
      ? await resolveLocalSourceListId(client, connectorId, sourceListId)
      : null;
    const sourceList = localSourceListId
      ? await identityForBinding(client, connectorId, 'source_list', localSourceListId, 'source_repository')
      : issue
        ? await repositoryForIssue(client, issue, 'source_repository')
        : null;
    if (!sourceList) return null;
    if (issue && sourceList.entityId !== issue.repositoryEntityId) return null;
    result.push(sourceList);
    if (targetSourceListId) {
      const localTargetSourceListId = await resolveLocalSourceListId(
        client,
        connectorId,
        targetSourceListId,
      );
      const target = localTargetSourceListId
        ? await identityForBinding(
            client,
            connectorId,
            'source_list',
            localTargetSourceListId,
            'target_repository',
          )
        : null;
      if (!target) return null;
      result.push(target);
    }
    for (const participant of participants ?? []) {
      const identity = await identityForBinding(
        client,
        connectorId,
        'task',
        participant.taskId,
        participant.role,
      );
      if (!identity) return null;
      result.push(identity);
    }
    if (operation === 'create' && !result.some((target) => target.role === 'source_repository')) {
      return null;
    }
    return result;
  }
  async function hasOpenStableIdentityCollision(
    client: Client,
    connectorInstanceId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
  ): Promise<boolean> {
    const { rows } = await query<{ value: number }>(
      client,
      `
        SELECT 1 AS value
        FROM github_identity_collisions AS collision
        WHERE collision.connector_instance_id = $1
          AND collision.binding_type = $2
          AND collision.state = 'open'
          AND (
            jsonb_typeof(collision.local_ids) IS DISTINCT FROM 'array'
            OR collision.local_ids @> jsonb_build_array($3::text)
          )
        LIMIT 1
      `,
      [connectorInstanceId, bindingType, localId],
    );
    return rows.length > 0;
  }

  async function currentLeaseTargetsMatch(
    client: Client,
    leaseId: string,
    requireTargets = false,
  ): Promise<boolean> {
    if (requireTargets) {
      const { rows } = await query<{ value: number }>(
        client,
        `
          SELECT 1 AS value
          FROM task_source_write_lease_targets
          WHERE lease_id = $1
          LIMIT 1
        `,
        [leaseId],
      );
      if (rows.length === 0) return false;
    }
    const { rows } = await query<{ value: number }>(
      client,
      `
        SELECT COUNT(*)::int AS value
        FROM task_source_write_lease_targets AS target
        LEFT JOIN external_entity_locators AS locator
          ON locator.external_entity_id = target.external_entity_id
          AND locator.valid_to IS NULL
        LEFT JOIN task_source_write_leases AS lease ON lease.id = target.lease_id
        LEFT JOIN external_entity_bindings AS binding
          ON binding.connector_instance_id = lease.connector_instance_id
          AND binding.external_entity_id = target.external_entity_id
          AND binding.state IN ('shadow', 'active')
        WHERE target.lease_id = $1
          AND (
            target.external_entity_id IS NULL
            OR locator.id IS NULL
            OR (
              COALESCE(target.binding_revision, '') <> ''
              AND (binding.id IS NULL OR binding.verified_at IS DISTINCT FROM target.binding_revision)
            )
            OR locator.locator_revision IS DISTINCT FROM target.locator_revision
            OR lower(locator.owner) <> lower(target.owner)
            OR lower(locator.repository) <> lower(target.repository)
            OR COALESCE(locator.issue_number, -1) <> COALESCE(target.issue_number, -1)
          )
      `,
      [leaseId],
    );
    return (rows[0]?.value ?? 0) === 0;
  }

  async function incrementCycleOutcome(
    client: Client,
    cycleId: string,
    outcome: 'succeeded' | 'failed' | 'blocked' | 'unknown',
  ): Promise<number> {
    const column = {
      succeeded: 'applied_count',
      failed: 'failed_count',
      blocked: 'blocked_count',
      unknown: 'unknown_count',
    }[outcome];
    const { rowCount } = await query(
      client,
      `
        UPDATE github_identity_write_cycles
        SET ${column} = ${column} + 1
        WHERE id = $1
          AND state = 'running'
          AND reconciliation_state = 'unresolved'
      `,
      [cycleId],
    );
    return rowCount;
  }

  function projectTaskRow(task: DbTaskRow): GitHubFenceTaskRow {
    return {
      id: task.id,
      sourceId: task.sourceId,
      sourceListId: task.sourceListId,
      updatedAt: task.updatedAt,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      effort: task.effort,
      dueDate: task.dueDate,
      microStatus: task.microStatus,
      parentId: task.parentId,
      isChecklistItem: task.isChecklistItem,
    };
  }

  function projectTargets(targets: readonly IdentityTargetRow[]): GitHubFenceTarget[] {
    return targets.map((target) => ({
      role: target.role,
      entityId: target.entityId,
      repositoryEntityId: target.repositoryEntityId,
      hostKey: target.hostKey,
      locatorRevision: target.locatorRevision,
      owner: target.owner,
      repository: target.repository,
      issueNumber: target.issueNumber,
      bindingRevision: target.bindingRevision,
      bindingState: target.bindingState,
    }));
  }

  // ── External entity directory helpers (generic, operator + non-batch callers) ──
  //
  // These mirror the pure business rules in `src/lib/external-identities/service.ts`
  // (`validateIdentity`, `validateObservation`, `normalizeExternalEntityLocator`,
  // `identityKey`) exactly, but are re-declared locally rather than imported so this
  // adapter has no runtime dependency on lib-level helpers beyond the shared types.

  function operatorEntityIdentityKey(identity: ExternalEntityIdentity): string {
    return `${identity.provider}\0${identity.hostKey}\0${identity.entityType}\0${identity.stableId}`;
  }

  function validateOperatorEntityIdentity(identity: ExternalEntityIdentity): void {
    if (!identity.provider || !identity.hostKey || !identity.stableId) {
      throw new Error('External entity key is incomplete');
    }
    if (identity.entityType !== 'repository' && identity.entityType !== 'issue') {
      throw new Error('External entity type is invalid');
    }
  }

  function validateOperatorObservation(observation: ExternalIdentityObservation): void {
    const { identity, locator } = observation;
    validateOperatorEntityIdentity(identity);
    if (!locator.owner || !locator.repository) {
      throw new Error('External identity observation is incomplete');
    }
    if (identity.entityType === 'issue') {
      if (!Number.isSafeInteger(locator.issueNumber) || (locator.issueNumber ?? 0) <= 0) {
        throw new Error('Issue identity observation requires a positive issue number');
      }
    } else if (locator.issueNumber !== undefined) {
      throw new Error('Repository locator must not include an issue number');
    }
  }

  function normalizeOperatorLocator(
    locator: ExternalEntityLocatorEvidence,
  ): NormalizedExternalEntityLocator {
    if (!locator.owner || !locator.repository) {
      throw new Error('External entity locator is incomplete');
    }
    if (
      locator.issueNumber !== undefined
      && (!Number.isSafeInteger(locator.issueNumber) || locator.issueNumber <= 0)
    ) {
      throw new Error('External entity issue number must be a positive integer');
    }
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

  interface OperatorExternalEntityRow {
    id: string;
    provider: string;
    hostKey: string;
    entityType: ExternalEntityType;
    stableId: string;
    identityVersion: number;
    nextLocatorRevision: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }

  function toOperatorEntityRecord(row: OperatorExternalEntityRow): ExternalEntityRecord {
    return {
      id: row.id,
      identity: {
        provider: row.provider,
        hostKey: row.hostKey,
        entityType: row.entityType,
        stableId: row.stableId,
      },
      identityVersion: row.identityVersion,
      nextLocatorRevision: row.nextLocatorRevision,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  const OPERATOR_ENTITY_COLUMNS = `
    id, provider, host_key AS "hostKey", entity_type AS "entityType", stable_id AS "stableId",
    identity_version AS "identityVersion", next_locator_revision AS "nextLocatorRevision",
    first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
  `;

  interface OperatorExternalEntityLocatorRow {
    id: string;
    externalEntityId: string;
    repositoryEntityId: string | null;
    owner: string;
    repository: string;
    ownerKey: string;
    repositoryKey: string;
    issueNumber: number | null;
    apiUrl: string | null;
    webUrl: string | null;
    validFrom: string;
    validTo: string | null;
    lastSeenAt: string;
    observationSource: ExternalLocatorSource;
    locatorRevision: number;
  }

  function toOperatorLocatorRecord(
    row: OperatorExternalEntityLocatorRow,
  ): ExternalEntityLocatorRecord {
    return { ...row };
  }

  const OPERATOR_LOCATOR_COLUMNS = `
    id, external_entity_id AS "externalEntityId", repository_entity_id AS "repositoryEntityId",
    owner, repository, owner_key AS "ownerKey", repository_key AS "repositoryKey",
    issue_number AS "issueNumber", api_url AS "apiUrl", web_url AS "webUrl",
    valid_from AS "validFrom", valid_to AS "validTo", last_seen_at AS "lastSeenAt",
    observation_source AS "observationSource", locator_revision AS "locatorRevision"
  `;

  async function requireOperatorExternalEntity(
    client: Client,
    entityId: string,
    identity: ExternalEntityIdentity,
    forUpdate: boolean,
  ): Promise<OperatorExternalEntityRow> {
    if (!entityId) throw new Error('External entity ID is required');
    validateOperatorEntityIdentity(identity);
    const { rows } = await query<OperatorExternalEntityRow>(
      client,
      `
        SELECT ${OPERATOR_ENTITY_COLUMNS}
        FROM external_entities
        WHERE id = $1
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      [entityId],
    );
    const row = rows[0];
    if (!row) throw new Error('External entity was not found');
    if (operatorEntityIdentityKey({
      provider: row.provider,
      hostKey: row.hostKey,
      entityType: row.entityType,
      stableId: row.stableId,
    }) !== operatorEntityIdentityKey(identity)) {
      throw new Error('External entity ID does not match the supplied key');
    }
    return row;
  }

  async function validateOperatorLocatorObservation(
    client: Client,
    input: ExternalEntityLocatorObservation,
  ): Promise<void> {
    validateOperatorObservation({
      identity: input.identity,
      locator: input.locator,
      observationSource: 'operator',
      observedAt: input.observedAt,
    });
    if (!input.observedAt) throw new Error('External locator observation time is required');

    const repositoryEntityId = input.repositoryEntityId ?? null;
    if (input.identity.entityType === 'repository') {
      if (repositoryEntityId !== null) {
        throw new Error('Repository locator must not reference a repository entity');
      }
      return;
    }
    if (!repositoryEntityId) {
      throw new Error('Issue locator requires a repository entity');
    }
    const { rows } = await query<OperatorExternalEntityRow>(
      client,
      `SELECT ${OPERATOR_ENTITY_COLUMNS} FROM external_entities WHERE id = $1 LIMIT 1`,
      [repositoryEntityId],
    );
    const repository = rows[0];
    if (
      !repository
      || repository.entityType !== 'repository'
      || repository.provider !== input.identity.provider
      || repository.hostKey !== input.identity.hostKey
    ) {
      throw new Error('Issue locator repository entity does not match its provider and host');
    }
  }

  function sameOperatorLocator(
    current: OperatorExternalEntityLocatorRow,
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

  function mergeOperatorLocatorWithCurrent(
    locator: NormalizedExternalEntityLocator,
    current: OperatorExternalEntityLocatorRow | undefined,
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

  async function evaluateOperatorLocatorPreflight(
    client: Client,
    entity: { id: string; identity: ExternalEntityIdentity },
    observation: ExternalIdentityObservation,
    forUpdate: boolean,
  ): Promise<ExternalEntityLocatorPreflight> {
    let locator = normalizeOperatorLocator(observation.locator);
    const { rows: currentRows } = await query<OperatorExternalEntityLocatorRow>(
      client,
      `
        SELECT ${OPERATOR_LOCATOR_COLUMNS}
        FROM external_entity_locators
        WHERE external_entity_id = $1
          AND valid_to IS NULL
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      [entity.id],
    );
    const currentRow = currentRows[0];
    locator = mergeOperatorLocatorWithCurrent(locator, currentRow);
    const current = currentRow ? toOperatorLocatorRecord(currentRow) : null;

    if (
      currentRow
      && observation.observedAt < currentRow.validFrom
      && !sameOperatorLocator(currentRow, locator)
    ) {
      return {
        state: 'collision',
        locator,
        current,
        collisionCategory: 'locator_overlap_or_regression',
        conflictingEntityId: entity.id,
      };
    }
    if (currentRow && sameOperatorLocator(currentRow, locator)) {
      return { state: 'unchanged', locator, current };
    }

    const { rows: pathConflictRows } = await query<{ externalEntityId: string }>(
      client,
      `
        SELECT external_entity_id AS "externalEntityId"
        FROM external_entity_locators
        WHERE provider = $1
          AND host_key = $2
          AND owner_key = $3
          AND repository_key = $4
          AND ${locator.issueNumber === null ? 'issue_number IS NULL' : 'issue_number = $5'}
          AND valid_to IS NULL
        LIMIT 1
      `,
      locator.issueNumber === null
        ? [entity.identity.provider, entity.identity.hostKey, locator.ownerKey, locator.repositoryKey]
        : [
          entity.identity.provider,
          entity.identity.hostKey,
          locator.ownerKey,
          locator.repositoryKey,
          locator.issueNumber,
        ],
    );
    const pathConflict = pathConflictRows[0];
    if (pathConflict && pathConflict.externalEntityId !== entity.id) {
      return {
        state: 'collision',
        locator,
        current,
        collisionCategory: entity.identity.entityType === 'repository'
          ? 'repository_path_replacement'
          : 'stable_legacy_disagree',
        conflictingEntityId: pathConflict.externalEntityId,
      };
    }
    return { state: 'update', locator, current };
  }

  const identity: GitHubIdentityPersistence = {
    async getModeSnapshot(connectorInstanceId, capturedAt = new Date().toISOString()) {
      const modeRevision = await readModeRevision(pool, connectorInstanceId);
      return Object.freeze({
        connectorInstanceId,
        effectiveMode: GITHUB_IDENTITY_MODE,
        modeRevision,
        capturedAt,
      });
    },

    async ensureControls({ connectorInstanceId, now }) {
      await query(
        pool,
        `
          INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
          VALUES ($1, 1, $2)
          ON CONFLICT (connector_instance_id) DO NOTHING
        `,
        [connectorInstanceId, now],
      );
    },

    async persistExternalIdentityBatch({ connectorInstanceId, modeSnapshot, writes }) {
      if (writes.length === 0) return [];
      if (writes.length > MAX_PRIMARY_IDENTITY_BATCH_SIZE) {
        throw new Error(
          `External identity batch exceeds the maximum of ${MAX_PRIMARY_IDENTITY_BATCH_SIZE}`,
        );
      }
      if (writes.some((write) => (
        write.target.connectorInstanceId !== connectorInstanceId
      ))) {
        throw new Error('External identity batches must contain one connector instance');
      }
      for (const write of writes) validatePrimaryIdentityWrite(write);

      return transaction(pool, async (client) => {
        await query(
          client,
          `
            SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
            FROM unnest($1::text[]) AS lock_keys(lock_key)
            ORDER BY lock_key
          `,
          [primaryIdentityLockKeys(connectorInstanceId, writes)],
        );
        if (modeSnapshot) {
          const current = await readModeRevisionForShare(
            client,
            modeSnapshot.connectorInstanceId,
          );
          if (current === null) {
            throw new Error(
              `GitHub identity controls are missing for ${modeSnapshot.connectorInstanceId}`,
            );
          }
          if (
            modeSnapshot.connectorInstanceId !== connectorInstanceId
            || current !== modeSnapshot.modeRevision
          ) {
            throw new Error(
              `GitHub identity revision changed from ${modeSnapshot.modeRevision} to ${current}`,
            );
          }
        }
        const results: Array<ExternalIdentityWriteResult | undefined> =
          Array.from({ length: writes.length });
        const { fastIndexes, sequentialIndexes } = partitionPrimaryIdentityWrites(writes);
        if (sequentialIndexes.length > 0) {
          for (const [index, write] of writes.entries()) {
            results[index] = await persistPrimaryIdentityWrite(client, write);
          }
        } else {
          await persistPrimaryIdentityFastBatch(client, writes, fastIndexes, results);
        }
        return results.map((result, index) => {
          if (!result) {
            throw new Error(`External identity batch result missing at index ${index}`);
          }
          return result;
        });
      });
    },

    async lookupStableIdentityBatch({ connectorInstanceId, namespace, rows }) {
      if (rows.length === 0) return [];
      const candidateKeys = rows.map((row) => row.candidateKey);
      const stableIds = rows.map((row) => row.stableId);
      const ownerKeys = rows.map((row) => row.ownerKey);
      const repositoryKeys = rows.map((row) => row.repositoryKey);
      const issueNumbers = rows.map((row) => row.issueNumber);
      const result = await query<GitHubStableLookupRow>(
        pool,
        `
          WITH incoming(candidate_key, stable_id, owner_key, repository_key, issue_number) AS (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
          )
          SELECT
            incoming.candidate_key AS "candidateKey",
            entity.id AS "externalEntityId",
            binding.local_id AS "bindingLocalId",
            CASE
              WHEN binding.binding_type = 'task' AND local_task.id IS NOT NULL
                THEN binding.local_id
              WHEN binding.binding_type = 'source_list' AND local_source_list.id IS NOT NULL
                THEN binding.local_id
              ELSE NULL
            END AS "localId",
            binding.state AS "bindingState",
            binding.verified_at AS "bindingRevision",
            current_locator.locator_revision AS "locatorRevision",
            current_locator.owner_key AS "currentOwnerKey",
            current_locator.repository_key AS "currentRepositoryKey",
            current_locator.issue_number AS "currentIssueNumber",
            path_locator.external_entity_id AS "pathEntityId"
          FROM incoming
          LEFT JOIN external_entities AS entity
            ON entity.provider = $6
            AND entity.host_key = $7
            AND entity.entity_type = $8
            AND entity.stable_id = incoming.stable_id
          LEFT JOIN external_entity_bindings AS binding
            ON binding.external_entity_id = entity.id
            AND binding.connector_instance_id = $9
            AND binding.binding_type = $10
            AND binding.state != 'retired'
          LEFT JOIN tasks AS local_task
            ON binding.binding_type = 'task'
            AND local_task.id = binding.local_id
            AND local_task.connector_instance_id = binding.connector_instance_id
          LEFT JOIN source_lists AS local_source_list
            ON binding.binding_type = 'source_list'
            AND local_source_list.id = binding.local_id
            AND local_source_list.connector_instance_id = binding.connector_instance_id
          LEFT JOIN external_entity_locators AS current_locator
            ON current_locator.external_entity_id = entity.id
            AND current_locator.valid_to IS NULL
          LEFT JOIN external_entity_locators AS path_locator
            ON path_locator.provider = $11
            AND path_locator.host_key = $12
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.valid_to IS NULL
            AND (
              path_locator.issue_number = incoming.issue_number
              OR (path_locator.issue_number IS NULL AND incoming.issue_number IS NULL)
            )
          ORDER BY incoming.candidate_key, binding.local_id NULLS FIRST
        `,
        [
          candidateKeys,
          stableIds,
          ownerKeys,
          repositoryKeys,
          issueNumbers,
          namespace.provider,
          namespace.hostKey,
          namespace.entityType,
          connectorInstanceId,
          namespace.bindingType,
          namespace.provider,
          namespace.hostKey,
        ],
      );
      return result.rows;
    },

    async lookupLinkedSourceIdentityBatch({ connectorInstanceId, hostKey, rows }) {
      if (rows.length === 0) return [];
      const candidateKeys = rows.map((row) => row.candidateKey);
      const linkedSourceIds = rows.map((row) => row.linkedSourceId);
      const stableIds = rows.map((row) => row.stableId);
      const ownerKeys = rows.map((row) => row.ownerKey);
      const repositoryKeys = rows.map((row) => row.repositoryKey);
      const issueNumbers = rows.map((row) => row.issueNumber);
      const result = await query<GitHubLinkedSourceLookupRow>(
        pool,
        `
          WITH incoming(
            candidate_key, linked_source_id, stable_id, owner_key, repository_key, issue_number
          ) AS (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[])
          )
          SELECT
            incoming.candidate_key AS "candidateKey",
            legacy_link.task_id AS "linkedTaskId",
            linked_association.external_entity_id AS "linkedEntityId",
            stable_entity.id AS "stableEntityId",
            stable_association.linked_source_id AS "stableLinkedSourceId",
            stable_link.task_id AS "stableTaskId",
            current_locator.locator_revision AS "locatorRevision",
            current_locator.owner_key AS "currentOwnerKey",
            current_locator.repository_key AS "currentRepositoryKey",
            current_locator.issue_number AS "currentIssueNumber",
            path_locator.external_entity_id AS "pathEntityId"
          FROM incoming
          INNER JOIN task_linked_sources AS legacy_link
            ON legacy_link.id = incoming.linked_source_id
            AND legacy_link.connector_instance_id = $7
            AND legacy_link.connector_type = 'github-issues'
          LEFT JOIN task_linked_source_entities AS linked_association
            ON linked_association.linked_source_id = legacy_link.id
            AND linked_association.connector_instance_id = $8
          LEFT JOIN external_entities AS stable_entity
            ON stable_entity.provider = $9
            AND stable_entity.host_key = $10
            AND stable_entity.entity_type = $11
            AND stable_entity.stable_id = incoming.stable_id
          LEFT JOIN task_linked_source_entities AS stable_association
            ON stable_association.connector_instance_id = $12
            AND stable_association.external_entity_id = stable_entity.id
          LEFT JOIN task_linked_sources AS stable_link
            ON stable_link.id = stable_association.linked_source_id
            AND stable_link.connector_instance_id = $13
          LEFT JOIN external_entity_locators AS current_locator
            ON current_locator.external_entity_id = stable_entity.id
            AND current_locator.valid_to IS NULL
          LEFT JOIN external_entity_locators AS path_locator
            ON path_locator.provider = $14
            AND path_locator.host_key = $15
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.issue_number = incoming.issue_number
            AND path_locator.valid_to IS NULL
          ORDER BY incoming.candidate_key
        `,
        [
          candidateKeys,
          linkedSourceIds,
          stableIds,
          ownerKeys,
          repositoryKeys,
          issueNumbers,
          connectorInstanceId,
          connectorInstanceId,
          'github',
          hostKey,
          'issue',
          connectorInstanceId,
          connectorInstanceId,
          'github',
          hostKey,
        ],
      );
      return result.rows;
    },
    async persistLinkedSourceIdentityBatch({ connectorInstanceId, modeSnapshot, writes }) {
      if (writes.length === 0) return [];
      return transaction(pool, async (client) => {
        if (modeSnapshot) {
          const current = await readModeRevision(client, modeSnapshot.connectorInstanceId);
          if (current !== modeSnapshot.modeRevision) {
            throw new Error(
              `GitHub identity revision changed from ${modeSnapshot.modeRevision} to ${current}`,
            );
          }
        }
        const linkedIds = writes.map((write) => write.linkedSourceId);
        const linkedResult = await query<{
          id: string;
          connectorInstanceId: string;
          connectorType: string;
          sourceId: string;
        }>(
          client,
          `
            SELECT
              id,
              connector_instance_id AS "connectorInstanceId",
              connector_type AS "connectorType",
              source_id AS "sourceId"
            FROM task_linked_sources
            WHERE connector_instance_id = $1
              AND connector_type = 'github-issues'
              AND id = ANY($2::text[])
          `,
          [connectorInstanceId, linkedIds],
        );
        const linkedById = new Map(linkedResult.rows.map((row) => [row.id, row]));
        const results: GitHubLinkedSourcePersistResult[] = [];

        for (const write of writes) {
          const linked = linkedById.get(write.linkedSourceId);
          if (!linked || !write.hasEvidence) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
            continue;
          }
          if (!write.identityValid) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          const entityResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM external_entities
              WHERE provider = $1
                AND host_key = $2
                AND entity_type = $3
                AND stable_id = $4
              LIMIT 1
            `,
            [write.provider, write.hostKey, write.entityType, write.stableId],
          );
          const entity = entityResult.rows[0];
          if (!entity) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
            continue;
          }
          const locatorResult = await query<{
            ownerKey: string;
            repositoryKey: string;
            issueNumber: number | null;
          }>(
            client,
            `
              SELECT
                owner_key AS "ownerKey",
                repository_key AS "repositoryKey",
                issue_number AS "issueNumber"
              FROM external_entity_locators
              WHERE external_entity_id = $1
                AND valid_to IS NULL
              LIMIT 1
            `,
            [entity.id],
          );
          const locator = locatorResult.rows[0];
          if (
            !locator
            || locator.ownerKey !== write.ownerKey
            || locator.repositoryKey !== write.repositoryKey
            || locator.issueNumber !== write.issueNumber
          ) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          const existingForLinkedResult = await query<{
            linkedSourceId: string;
            connectorInstanceId: string;
            externalEntityId: string;
          }>(
            client,
            `
              SELECT
                linked_source_id AS "linkedSourceId",
                connector_instance_id AS "connectorInstanceId",
                external_entity_id AS "externalEntityId"
              FROM task_linked_source_entities
              WHERE linked_source_id = $1
              LIMIT 1
            `,
            [linked.id],
          );
          const existingForEntityResult = await query<{ linkedSourceId: string }>(
            client,
            `
              SELECT linked_source_id AS "linkedSourceId"
              FROM task_linked_source_entities
              WHERE connector_instance_id = $1
                AND external_entity_id = $2
              LIMIT 1
            `,
            [connectorInstanceId, entity.id],
          );
          const existingForLinked = existingForLinkedResult.rows[0];
          const existingForEntity = existingForEntityResult.rows[0];
          const locatorMatchesLegacy = write.canonicalSourceId.toLowerCase() === linked.sourceId.toLowerCase();
          if (
            (existingForLinked
              && (existingForLinked.externalEntityId !== entity.id
                || existingForLinked.connectorInstanceId !== connectorInstanceId))
            || (existingForEntity && existingForEntity.linkedSourceId !== linked.id)
            || (!existingForLinked && !locatorMatchesLegacy)
          ) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          if (linked.sourceId !== write.canonicalSourceId) {
            await query(
              client,
              `UPDATE task_linked_sources SET source_id = $1 WHERE id = $2`,
              [write.canonicalSourceId, linked.id],
            );
          }
          await query(
            client,
            `
              INSERT INTO task_linked_source_entities (
                linked_source_id, connector_instance_id, external_entity_id,
                verified_at, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $4, $4)
              ON CONFLICT (linked_source_id) DO UPDATE SET
                verified_at = EXCLUDED.verified_at,
                updated_at = EXCLUDED.updated_at
            `,
            [linked.id, connectorInstanceId, entity.id, write.observedAt],
          );
          results.push({ linkedSourceId: write.linkedSourceId, state: 'associated' });
        }
        return results;
      });
    },

    async checkDecisionsCurrent({ connectorInstanceId, checks }) {
      for (const check of checks) {
        const { rows } = await query<{ value: number }>(
          pool,
          `
            SELECT 1 AS value
            FROM external_entity_bindings AS binding
            INNER JOIN external_entity_locators AS locator
              ON locator.external_entity_id = binding.external_entity_id
              AND locator.valid_to IS NULL
            WHERE binding.connector_instance_id = $1
              AND binding.binding_type = $2
              AND binding.local_id = $3
              AND binding.external_entity_id = $4
              AND binding.state = 'active'
              AND binding.verified_at = $5
              AND locator.locator_revision = $6
            LIMIT 1
          `,
          [
            connectorInstanceId,
            check.bindingType,
            check.localId,
            check.externalEntityId,
            check.bindingRevision,
            check.locatorRevision,
          ],
        );
        if (rows.length === 0) return false;
      }
      return true;
    },

    async getLatestTerminalInaccessibleException({ connectorInstanceId, bindingType, localId }) {
      const { rows } = await query<GitHubIdentityExceptionSnapshot>(
        pool,
        `
          SELECT
            id AS "eventId",
            connector_instance_id AS "connectorInstanceId",
            binding_type AS "bindingType",
            local_id AS "localId",
            category,
            action,
            proof_type AS "proofType",
            created_at AS "createdAt"
          FROM github_identity_exception_events
          WHERE connector_instance_id = $1
            AND binding_type = $2
            AND local_id = $3
            AND category = 'terminal_inaccessible'
          ORDER BY id DESC
          LIMIT 1
        `,
        [connectorInstanceId, bindingType, localId],
      );
      return rows[0] ?? null;
    },

    // ── External entity directory (generic, operator + non-batch callers) ───────

    async getExternalEntityByKey(key: ExternalEntityKey) {
      validateOperatorEntityIdentity(key);
      const { rows } = await query<OperatorExternalEntityRow>(
        pool,
        `
          SELECT ${OPERATOR_ENTITY_COLUMNS}
          FROM external_entities
          WHERE provider = $1
            AND host_key = $2
            AND entity_type = $3
            AND stable_id = $4
          LIMIT 1
        `,
        [key.provider, key.hostKey, key.entityType, key.stableId],
      );
      const row = rows[0];
      return row ? toOperatorEntityRecord(row) : null;
    },

    async upsertExternalEntity(input: ExternalEntityUpsert) {
      validateOperatorEntityIdentity(input.identity);
      if (!input.observedAt) throw new Error('External entity observation time is required');
      const { identity, observedAt } = input;
      const { rows } = await query<OperatorExternalEntityRow>(
        pool,
        `
          INSERT INTO external_entities (
            id, provider, host_key, entity_type, stable_id,
            identity_version, next_locator_revision, first_seen_at, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
          ON CONFLICT (provider, host_key, entity_type, stable_id) DO UPDATE SET
            last_seen_at = GREATEST(external_entities.last_seen_at, EXCLUDED.last_seen_at)
          RETURNING ${OPERATOR_ENTITY_COLUMNS}
        `,
        [randomUUID(), identity.provider, identity.hostKey, identity.entityType, identity.stableId, observedAt],
      );
      const row = rows[0];
      if (!row) throw new Error('Failed to persist external entity');
      return toOperatorEntityRecord(row);
    },

    async getCurrentExternalEntityLocator(externalEntityId: string) {
      if (!externalEntityId) throw new Error('External entity ID is required');
      const { rows } = await query<OperatorExternalEntityLocatorRow>(
        pool,
        `
          SELECT ${OPERATOR_LOCATOR_COLUMNS}
          FROM external_entity_locators
          WHERE external_entity_id = $1
            AND valid_to IS NULL
          LIMIT 1
        `,
        [externalEntityId],
      );
      const row = rows[0];
      return row ? toOperatorLocatorRecord(row) : null;
    },

    async listExternalEntityLocatorHistory(externalEntityId: string) {
      if (!externalEntityId) throw new Error('External entity ID is required');
      const { rows } = await query<OperatorExternalEntityLocatorRow>(
        pool,
        `
          SELECT ${OPERATOR_LOCATOR_COLUMNS}
          FROM external_entity_locators
          WHERE external_entity_id = $1
          ORDER BY locator_revision
        `,
        [externalEntityId],
      );
      return rows.map(toOperatorLocatorRecord);
    },

    async preflightExternalEntityLocator(input: ExternalEntityLocatorObservation) {
      const entityRow = await requireOperatorExternalEntity(
        pool,
        input.entityId,
        input.identity,
        false,
      );
      const entity = toOperatorEntityRecord(entityRow);
      await validateOperatorLocatorObservation(pool, input);
      return evaluateOperatorLocatorPreflight(pool, entity, {
        identity: input.identity,
        locator: input.locator,
        observationSource: 'operator',
        observedAt: input.observedAt,
      }, false);
    },

    async observeExternalEntityLocator(input: ExternalEntityLocatorObservation) {
      return transaction(pool, async (client): Promise<ExternalEntityLocatorObservationResult> => {
        const entityRow = await requireOperatorExternalEntity(
          client,
          input.entityId,
          input.identity,
          true,
        );
        const entity = toOperatorEntityRecord(entityRow);
        await validateOperatorLocatorObservation(client, input);
        const observation: ExternalIdentityObservation = {
          identity: input.identity,
          locator: input.locator,
          observationSource: 'operator',
          observedAt: input.observedAt,
        };
        const preflight = await evaluateOperatorLocatorPreflight(client, entity, observation, true);
        if (preflight.state === 'collision') {
          return { ...preflight, locatorRecord: null };
        }

        if (preflight.state === 'unchanged') {
          const current = preflight.current!;
          if (input.observedAt > current.lastSeenAt) {
            await query(
              client,
              `UPDATE external_entity_locators SET last_seen_at = $1 WHERE id = $2`,
              [input.observedAt, current.id],
            );
            await query(
              client,
              `
                UPDATE external_entities
                SET last_seen_at = GREATEST(last_seen_at, $1)
                WHERE id = $2
              `,
              [input.observedAt, entity.id],
            );
          }
          return {
            ...preflight,
            locatorRecord: {
              ...current,
              lastSeenAt: input.observedAt > current.lastSeenAt
                ? input.observedAt
                : current.lastSeenAt,
            },
          };
        }

        const { rows: entityRows } = await query<{ nextLocatorRevision: number }>(
          client,
          `
            SELECT next_locator_revision AS "nextLocatorRevision"
            FROM external_entities
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [entity.id],
        );
        const nextEntityRow = entityRows[0];
        if (!nextEntityRow) throw new Error('External entity disappeared during locator update');

        if (preflight.current) {
          await query(
            client,
            `UPDATE external_entity_locators SET valid_to = $1 WHERE id = $2`,
            [input.observedAt, preflight.current.id],
          );
        }
        await query(
          client,
          `
            UPDATE external_entities
            SET next_locator_revision = $1,
                last_seen_at = GREATEST(last_seen_at, $2)
            WHERE id = $3
          `,
          [nextEntityRow.nextLocatorRevision + 1, input.observedAt, entity.id],
        );
        const { rows: insertedRows } = await query<OperatorExternalEntityLocatorRow>(
          client,
          `
            INSERT INTO external_entity_locators (
              id, external_entity_id, repository_entity_id, provider, host_key,
              owner, repository, owner_key, repository_key, issue_number, api_url, web_url,
              valid_from, valid_to, last_seen_at, observation_source, locator_revision
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $13, 'operator', $14
            )
            RETURNING ${OPERATOR_LOCATOR_COLUMNS}
          `,
          [
            randomUUID(),
            entity.id,
            input.repositoryEntityId ?? null,
            entity.identity.provider,
            entity.identity.hostKey,
            preflight.locator.owner,
            preflight.locator.repository,
            preflight.locator.ownerKey,
            preflight.locator.repositoryKey,
            preflight.locator.issueNumber,
            preflight.locator.apiUrl,
            preflight.locator.webUrl,
            input.observedAt,
            nextEntityRow.nextLocatorRevision,
          ],
        );
        const inserted = insertedRows[0];
        if (!inserted) throw new Error('Failed to persist external entity locator');
        return {
          ...preflight,
          locatorRecord: toOperatorLocatorRecord(inserted),
        };
      });
    },

    async recordExternalIdentityCollision(input: ExternalIdentityCollisionInput) {
      if (!input.connectorInstanceId || !input.observedAt) {
        throw new Error('External identity collision context is incomplete');
      }
      if (input.localIds.length === 0 || input.externalEntityIds.length === 0) {
        throw new Error('External identity collision requires local and entity IDs');
      }
      return transaction(pool, async (client): Promise<ExternalIdentityCollisionRecord> => {
        const boundedLocalIds = boundedPrimaryIdentityCollisionIds(input.localIds);
        const boundedEntityIds = boundedPrimaryIdentityCollisionIds(input.externalEntityIds);
        const fingerprint = digestExternalIdentifier(JSON.stringify({
          category: input.category,
          bindingType: input.bindingType,
          localIds: boundedLocalIds,
          externalEntityIds: boundedEntityIds,
        }));
        const legacyIdentityDigest = input.legacyIdentity
          ? digestExternalIdentifier(input.legacyIdentity)
          : null;

        const { rows } = await query<ExternalIdentityCollisionRecord>(
          client,
          `
            INSERT INTO github_identity_collisions (
              id, connector_instance_id, category, fingerprint, binding_type,
              local_ids, external_entity_ids, legacy_identity_digest, state,
              resolution, first_seen_at, last_seen_at, resolved_at, resolved_by
            ) VALUES (
              $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 'open',
              NULL, $9, $9, NULL, NULL
            )
            ON CONFLICT (connector_instance_id, category, fingerprint) DO UPDATE SET
              local_ids = EXCLUDED.local_ids,
              external_entity_ids = EXCLUDED.external_entity_ids,
              legacy_identity_digest = EXCLUDED.legacy_identity_digest,
              state = 'open',
              resolution = NULL,
              last_seen_at = EXCLUDED.last_seen_at,
              resolved_at = NULL,
              resolved_by = NULL
            RETURNING
              id,
              connector_instance_id AS "connectorInstanceId",
              category,
              fingerprint,
              binding_type AS "bindingType",
              local_ids AS "localIds",
              external_entity_ids AS "externalEntityIds",
              legacy_identity_digest AS "legacyIdentityDigest",
              state,
              first_seen_at AS "firstSeenAt",
              last_seen_at AS "lastSeenAt"
          `,
          [
            randomUUID(),
            input.connectorInstanceId,
            input.category,
            fingerprint,
            input.bindingType,
            JSON.stringify(boundedLocalIds),
            JSON.stringify(boundedEntityIds),
            legacyIdentityDigest,
            input.observedAt,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('Failed to record external identity collision');

        await query(
          client,
          `
            UPDATE external_entity_bindings
            SET state = 'collision', updated_at = $1
            WHERE connector_instance_id = $2
              AND binding_type = $3
              AND local_id = ANY($4::text[])
              AND state != 'retired'
          `,
          [input.observedAt, input.connectorInstanceId, input.bindingType, boundedLocalIds],
        );
        await query(
          client,
          `
            UPDATE external_entity_bindings
            SET state = 'collision', updated_at = $1
            WHERE connector_instance_id = $2
              AND external_entity_id = ANY($3::text[])
              AND state != 'retired'
          `,
          [input.observedAt, input.connectorInstanceId, boundedEntityIds],
        );

        return row;
      });
    },
  };

  const writeFence: GitHubWriteFencePersistence = {
    async beginWriteCycle({
      id,
      connectorInstanceId,
      jobId,
      expectedModeRevision,
      pendingCandidateCount,
      now,
    }): Promise<GitHubBeginWriteCycleResult> {
      return transaction(pool, async (client): Promise<GitHubBeginWriteCycleResult> => {
        if (await readModeRevision(client, connectorInstanceId) !== expectedModeRevision) {
          return { ok: false, code: 'stale_write_cycle_mode' };
        }
        const runningResult = await query<DbWriteCycleRow>(
          client,
          `
            SELECT ${WRITE_CYCLE_COLUMNS}
            FROM github_identity_write_cycles
            WHERE connector_instance_id = $1
              AND state = 'running'
            LIMIT 1
            FOR UPDATE
          `,
          [connectorInstanceId],
        );
        const running = runningResult.rows[0];
        if (running) {
          if (running.reconciliationState !== 'unresolved') {
            return { ok: false, code: 'write_cycle_reconciliation_owned' };
          }
          const activeOperationResult = await query<{ createdAt: string }>(
            client,
            `
              SELECT created_at AS "createdAt"
              FROM connector_operation_leases
              WHERE connector_id = $1
                AND lease_expires_at > $2
              LIMIT 1
            `,
            [connectorInstanceId, now],
          );
          const activeOperation = activeOperationResult.rows[0];
          if (activeOperation && activeOperation.createdAt <= running.startedAt) {
            return { ok: false, code: 'active_write_cycle' };
          }
          await query(
            client,
            `
              UPDATE task_source_write_leases
              SET state = 'expired', finalized_at = $1, updated_at = $1
              WHERE write_cycle_id = $2
                AND connector_instance_id = $3
                AND mode_revision = $4
                AND state IN ('claimed', 'authorized')
                AND dispatched_at IS NULL
                AND expires_at <= $1
            `,
            [now, running.id, running.connectorInstanceId, running.modeRevision],
          );
          const leasesResult = await query<DbLeaseRow>(
            client,
            `
              SELECT ${LEASE_COLUMNS}
              FROM task_source_write_leases
              WHERE write_cycle_id = $1
              FOR UPDATE
            `,
            [running.id],
          );
          const leases = leasesResult.rows;
          if (
            leases.some(
              (lease) =>
                lease.state === 'dispatched'
                || lease.state === 'unknown'
                || (['claimed', 'authorized'].includes(lease.state) && lease.expiresAt > now),
            )
          ) {
            return { ok: false, code: 'active_write_cycle' };
          }
          const locallyFinalized =
            leases.length === running.pendingCandidateCount
            && leases.every(
              (lease) =>
                ['succeeded', 'failed', 'blocked'].includes(lease.state)
                && lease.cycleOutcome === lease.state
                && lease.finalizedAt !== null,
            );
          const updateResult = locallyFinalized
            ? await query(
                client,
                `
                  UPDATE github_identity_write_cycles
                  SET observed_route_count = $1,
                      applied_count = $2,
                      blocked_count = $3,
                      failed_count = $4,
                      unknown_count = 0,
                      state = 'completed',
                      completed_at = $5
                  WHERE id = $6
                    AND state = 'running'
                    AND reconciliation_state = 'unresolved'
                `,
                [
                  leases.filter((lease) => lease.cycleObservedAt !== null).length,
                  leases.filter((lease) => lease.cycleOutcome === 'succeeded').length,
                  leases.filter((lease) => lease.cycleOutcome === 'blocked').length,
                  leases.filter((lease) => lease.cycleOutcome === 'failed').length,
                  now,
                  running.id,
                ],
              )
            : await query(
                client,
                `
                  UPDATE github_identity_write_cycles
                  SET state = 'interrupted', completed_at = $1
                  WHERE id = $2
                    AND state = 'running'
                    AND reconciliation_state = 'unresolved'
                `,
                [now, running.id],
              );
          if (updateResult.rowCount !== 1) {
            throw new RollbackSignal<GitHubBeginWriteCycleResult>({
              ok: false,
              code: 'write_cycle_replacement_lost',
            });
          }
        }        await query(
          client,
          `
            INSERT INTO github_identity_write_cycles (
              id, connector_instance_id, job_id, mode_revision,
              pending_candidate_count, started_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [id, connectorInstanceId, jobId ?? null, expectedModeRevision, pendingCandidateCount, now],
        );
        return { ok: true };
      });
    },

    async finishWriteCycle({ id, outcome, now }) {
      const result = await transaction(pool, async (client) => {
        const cycleResult = await query<DbWriteCycleRow>(
          client,
          `
            SELECT ${WRITE_CYCLE_COLUMNS}
            FROM github_identity_write_cycles
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [id],
        );
        const cycle = cycleResult.rows[0];
        if (!cycle) return { changed: 0, complete: false };
        if (await readModeRevision(client, cycle.connectorInstanceId) !== cycle.modeRevision) {
          return { changed: 0, complete: false };
        }
        const complete =
          outcome.observed === cycle.pendingCandidateCount
          && outcome.applied + outcome.blocked + outcome.failed + outcome.unknown === outcome.observed;
        const updateResult = await query(
          client,
          `
            UPDATE github_identity_write_cycles
            SET observed_route_count = $1,
                applied_count = $2,
                blocked_count = $3,
                failed_count = $4,
                unknown_count = $5,
                state = $6,
                completed_at = $7
            WHERE id = $8
              AND connector_instance_id = $9
              AND mode_revision = $10
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
          `,
          [
            outcome.observed,
            outcome.applied,
            outcome.blocked,
            outcome.failed,
            outcome.unknown,
            complete ? 'completed' : 'interrupted',
            now,
            id,
            cycle.connectorInstanceId,
            cycle.modeRevision,
          ],
        );
        return { changed: updateResult.rowCount, complete };
      });
      return { committed: result.changed === 1 && result.complete };
    },

    async recordCycleObservation({ leaseId, now }): Promise<GitHubRecordCycleObservationResult> {
      return transaction(pool, async (client): Promise<GitHubRecordCycleObservationResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND state = 'claimed'
              AND cycle_outcome IS NULL
            LIMIT 1
            FOR UPDATE
          `,
          [leaseId],
        );
        const lease = leaseResult.rows[0];
        if (!lease?.writeCycleId) {
          return { ok: false, code: 'write_cycle_missing' };
        }
        if (lease.cycleObservedAt) return { ok: true };
        if (await readModeRevision(client, lease.connectorInstanceId) !== lease.modeRevision) {
          return { ok: false, code: 'write_cycle_observation_stale_mode' };
        }
        const cycleChanged = await query(
          client,
          `
            UPDATE github_identity_write_cycles
            SET observed_route_count = observed_route_count + 1
            WHERE id = $1
              AND connector_instance_id = $2
              AND mode_revision = $3
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
          `,
          [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
        );
        if (cycleChanged.rowCount !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        const leaseChanged = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET cycle_observed_at = $1,
                updated_at = $1
            WHERE id = $2
              AND token = $3
              AND state = 'claimed'
              AND cycle_observed_at IS NULL
          `,
          [now, lease.id, lease.token],
        );
        if (leaseChanged.rowCount !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        return { ok: true };
      });
    },

    async authorizeTaskWrite(input): Promise<GitHubAuthorizeTaskWriteResult> {
      return transaction(pool, async (client): Promise<GitHubAuthorizeTaskWriteResult> => {
        const taskResult = await query<DbTaskRow>(
          client,
          `
            SELECT ${TASK_COLUMNS}
            FROM tasks
            WHERE id = $1
              AND connector_instance_id = $2
            LIMIT 1
            FOR UPDATE
          `,
          [input.taskId, input.connectorInstanceId],
        );
        const task = taskResult.rows[0];
        if (!task) return { ok: false, code: 'missing_task' };
        if (
          (input.expectedTaskVersion && task.updatedAt !== input.expectedTaskVersion)
          || (input.taskPushLeaseToken
            && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== input.taskPushLeaseToken))
        ) {
          return { ok: false, code: 'stale_task_push_claim' };
        }
        const modeRevision = await readModeRevision(client, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [input.writeCycleId, input.connectorInstanceId],
            )).rows[0]
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (await hasOpenStableIdentityCollision(client, input.connectorInstanceId, 'task', task.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const targets = await loadTargets(
          client,
          input.connectorInstanceId,
          task.id,
          task.sourceListId,
          task.sourceId,
          input.operation,
          input.targetSourceListId,
          input.participantTaskIds,
        );
        if (!targets) return { ok: false, code: 'missing_or_inaccessible_identity' };
        if (targets.some((target) => target.bindingState !== 'active')) {
          return { ok: false, code: 'stable_binding_not_active' };
        }
        const { idempotencyKey, intent, initialCreate } = input.deriveWriteIdentity(projectTaskRow(task));
        let priorSuccess = false;
        if (intent) {
          const params: unknown[] = [
            input.connectorInstanceId,
            task.id,
            input.operation,
            modeRevision,
          ];
          const identityClause = initialCreate
            ? ''
            : `
              AND idempotency_key = $${params.push(idempotencyKey)}
              AND intent_kind = $${params.push(intent.kind)}
              AND intent_digest = $${params.push(intent.digest)}
            `;
          const priorResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM task_source_write_leases
              WHERE connector_instance_id = $1
                AND task_id = $2
                AND operation = $3
                AND mode_revision = $4
                ${identityClause}
                AND state = 'succeeded'
                AND cycle_outcome = 'succeeded'
              LIMIT 10
            `,
            params,
          );
          for (const lease of priorResult.rows) {
            if (await currentLeaseTargetsMatch(client, lease.id, true)) {
              priorSuccess = true;
              break;
            }
          }
        }        if (priorSuccess) return { ok: false, code: 'write_already_succeeded' };
        const insertResult = await query(
          client,
          `
            INSERT INTO task_source_write_leases (
              id, token, connector_instance_id, task_id, operation, task_version,
              idempotency_key, mode_revision, write_cycle_id, intent_kind, intent_digest,
              expires_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
            ON CONFLICT DO NOTHING
          `,
          [
            input.leaseId,
            input.token,
            input.connectorInstanceId,
            task.id,
            input.operation,
            task.updatedAt,
            idempotencyKey,
            modeRevision,
            input.writeCycleId,
            intent?.kind ?? null,
            intent?.digest ?? null,
            input.expiresAt,
            input.now,
          ],
        );
        if (insertResult.rowCount !== 1) {
          throw new RollbackSignal<GitHubAuthorizeTaskWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        for (const target of targets) {
          await query(
            client,
            `
              INSERT INTO task_source_write_lease_targets (
                lease_id, role, external_entity_id, repository_entity_id, host_key,
                locator_revision, binding_revision, legacy_locator_digest,
                owner, repository, issue_number
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
            [
              input.leaseId,
              target.role,
              target.entityId,
              target.repositoryEntityId,
              target.hostKey,
              target.locatorRevision,
              target.bindingRevision,
              digestLocator(target.owner, target.repository, target.issueNumber),
              target.owner,
              target.repository,
              target.issueNumber,
            ],
          );
        }
        return {
          ok: true,
          task: projectTaskRow(task),
          modeRevision,
          leaseId: input.leaseId,
          targets: projectTargets(targets),
        };
      });
    },

    async authorizeSourceWrite(input): Promise<GitHubAuthorizeSourceWriteResult> {
      return transaction(pool, async (client): Promise<GitHubAuthorizeSourceWriteResult> => {
        const sourceListResult = await query<DbSourceListRow>(
          client,
          `
            SELECT
              id,
              connector_instance_id AS "connectorInstanceId",
              source_id AS "sourceId"
            FROM source_lists
            WHERE connector_instance_id = $1
              AND id = $2
            LIMIT 1
            FOR UPDATE
          `,
          [input.connectorInstanceId, input.sourceListId],
        );
        const sourceList = sourceListResult.rows[0];
        if (!sourceList) return { ok: false, code: 'missing_source_list' };
        const modeRevision = await readModeRevision(client, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [input.writeCycleId, input.connectorInstanceId],
            )).rows[0]
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (await hasOpenStableIdentityCollision(client, input.connectorInstanceId, 'source_list', sourceList.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const target = await identityForBinding(
          client,
          input.connectorInstanceId,
          'source_list',
          sourceList.id,
          'source_repository',
        );
        if (!target) return { ok: false, code: 'missing_or_inaccessible_identity' };
        if (target.bindingState !== 'active') {
          return { ok: false, code: 'stable_binding_not_active' };
        }
        const idempotencyKey = `source-list:${sourceList.id}:${input.operation}:${sourceList.sourceId}`;
        const insertResult = await query(
          client,
          `
            INSERT INTO task_source_write_leases (
              id, token, connector_instance_id, task_id, operation, task_version,
              idempotency_key, mode_revision, write_cycle_id, expires_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
            ON CONFLICT DO NOTHING
          `,
          [
            input.leaseId,
            input.token,
            input.connectorInstanceId,
            `source-list:${sourceList.id}`,
            input.operation,
            sourceList.sourceId,
            idempotencyKey,
            modeRevision,
            input.writeCycleId,
            input.expiresAt,
            input.now,
          ],
        );
        if (insertResult.rowCount !== 1) {
          throw new RollbackSignal<GitHubAuthorizeSourceWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        await query(
          client,
          `
            INSERT INTO task_source_write_lease_targets (
              lease_id, role, external_entity_id, repository_entity_id, host_key,
              locator_revision, binding_revision, legacy_locator_digest,
              owner, repository, issue_number
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
          `,
          [
            input.leaseId,
            target.role,
            target.entityId,
            target.repositoryEntityId,
            target.hostKey,
            target.locatorRevision,
            target.bindingRevision,
            digestLocator(target.owner, target.repository, null),
            target.owner,
            target.repository,
          ],
        );
        return {
          ok: true,
          sourceList: { id: sourceList.id, sourceId: sourceList.sourceId },
          target: projectTargets([target])[0],
          leaseId: input.leaseId,
          modeRevision,
        };
      });
    },

    async hasSucceededWrite(input) {
      const taskResult = await query<DbTaskRow>(
        pool,
        `
          SELECT ${TASK_COLUMNS}
          FROM tasks
          WHERE id = $1
            AND connector_instance_id = $2
            AND updated_at = $3
            AND sync_status = 'pushing'
            AND last_synced_at = $4
          LIMIT 1
        `,
        [
          input.taskId,
          input.connectorInstanceId,
          input.expectedTaskVersion,
          input.taskPushLeaseToken,
        ],
      );
      const task = taskResult.rows[0];
      if (!task) return false;
      const { idempotencyKey, intent, initialCreate } = input.deriveWriteIdentity(projectTaskRow(task));
      if (!intent) return false;
      const modeRevision = await readModeRevision(pool, input.connectorInstanceId);
      const params: unknown[] = [
        input.connectorInstanceId,
        task.id,
        input.operation,
        modeRevision,
      ];
      const identityClause = initialCreate
        ? ''
        : `
          AND idempotency_key = $${params.push(idempotencyKey)}
          AND intent_kind = $${params.push(intent.kind)}
          AND intent_digest = $${params.push(intent.digest)}
        `;
      const priorResult = await query<{ id: string }>(
        pool,
        `
          SELECT id
          FROM task_source_write_leases
          WHERE connector_instance_id = $1
            AND task_id = $2
            AND operation = $3
            AND mode_revision = $4
            ${identityClause}
            AND state = 'succeeded'
            AND cycle_outcome = 'succeeded'
          LIMIT 10
        `,
        params,
      );
      for (const lease of priorResult.rows) {
        if (await currentLeaseTargetsMatch(pool, lease.id, true)) return true;
      }
      return false;
    },

    async assertCycleCurrent({ authorization }) {
      return transaction(pool, async (client) => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state IN ('claimed', 'authorized')
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return false;
        if (authorization.expectedTaskVersion || authorization.taskPushLeaseToken) {
          const taskResult = await query<DbTaskRow>(
            client,
            `
              SELECT ${TASK_COLUMNS}
              FROM tasks
              WHERE id = $1
                AND connector_instance_id = $2
              LIMIT 1
              FOR UPDATE
            `,
            [authorization.taskId, authorization.connectorInstanceId],
          );
          const task = taskResult.rows[0];
          if (
            !task
            || (authorization.expectedTaskVersion && task.updatedAt !== authorization.expectedTaskVersion)
            || (authorization.taskPushLeaseToken
              && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== authorization.taskPushLeaseToken))
          ) {
            return false;
          }
        }
        if (!lease.writeCycleId) return false;
        if (await readModeRevision(client, authorization.connectorInstanceId) !== lease.modeRevision) {
          return false;
        }
        const cycleResult = await query<{ id: string }>(
          client,
          `
            SELECT id
            FROM github_identity_write_cycles
            WHERE id = $1
              AND connector_instance_id = $2
              AND mode_revision = $3
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
            LIMIT 1
            FOR UPDATE
          `,
          [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
        );
        return cycleResult.rows.length > 0;
      });
    },
    async confirmDispatch({ authorization, now }) {
      const changes = await transaction(pool, async (client) => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state = 'claimed'
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token],
        );
        const lease = leaseResult.rows[0];
        if (!lease || lease.expiresAt <= now) return 0;
        const cycle = lease.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [lease.writeCycleId, authorization.connectorInstanceId],
            )).rows[0]
          : null;
        const modeRevision = await readModeRevision(client, authorization.connectorInstanceId);
        const sourceListSubject = authorization.taskId.startsWith('source-list:')
          ? (await query<DbSourceListRow>(
              client,
              `
                SELECT
                  id,
                  connector_instance_id AS "connectorInstanceId",
                  source_id AS "sourceId"
                FROM source_lists
                WHERE id = $1
                  AND connector_instance_id = $2
                LIMIT 1
                FOR UPDATE
              `,
              [authorization.taskId.slice('source-list:'.length), authorization.connectorInstanceId],
            )).rows[0]
          : null;
        const task = sourceListSubject
          ? null
          : (await query<DbTaskRow>(
              client,
              `
                SELECT ${TASK_COLUMNS}
                FROM tasks
                WHERE id = $1
                LIMIT 1
                FOR UPDATE
              `,
              [authorization.taskId],
            )).rows[0];
        if (
          (!task && !sourceListSubject)
          || (task && task.connectorInstanceId !== authorization.connectorInstanceId)
          || (task && task.updatedAt !== lease.taskVersion)
          || (task
            && authorization.taskPushLeaseToken
            && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== authorization.taskPushLeaseToken))
          || (sourceListSubject && sourceListSubject.sourceId !== lease.taskVersion)
          || modeRevision !== lease.modeRevision
          || lease.cycleObservedAt === null
          || !cycle
          || cycle.modeRevision !== lease.modeRevision
          || !await currentLeaseTargetsMatch(client, authorization.leaseId)
        ) {
          return 0;
        }
        const updateResult = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = 'dispatched',
                dispatched_at = $1,
                updated_at = $1
            WHERE id = $2
              AND token = $3
              AND state = 'claimed'
          `,
          [now, authorization.leaseId, authorization.token],
        );
        return updateResult.rowCount;
      });
      return changes === 1;
    },

    async verifyPreflight({ leaseId, observed }) {
      const { rows } = await query<{
        role: string;
        entityType: 'issue' | 'repository';
        stableId: string;
        repositoryStableId: string | null;
      }>(
        pool,
        `
          SELECT
            target.role AS role,
            entity.entity_type AS "entityType",
            entity.stable_id AS "stableId",
            repository.stable_id AS "repositoryStableId"
          FROM task_source_write_lease_targets AS target
          JOIN external_entities AS entity ON entity.id = target.external_entity_id
          LEFT JOIN external_entities AS repository ON repository.id = target.repository_entity_id
          WHERE target.lease_id = $1
        `,
        [leaseId],
      );
      if (
        rows.length === 0
        || rows.some((row) => {
          const value = observed.targets[row.role];
          return (
            !value
            || (row.entityType === 'issue'
              ? value.issueStableId !== row.stableId || value.repositoryStableId !== row.repositoryStableId
              : value.repositoryStableId !== row.stableId)
          );
        })
      ) {
        return false;
      }
      return true;
    },

    async finalizeWrite({ authorization, outcome, safeReason, resultDigest, now }): Promise<GitHubFinalizeWriteResult> {
      const allowedStates = outcome === 'failed'
        ? ['claimed', 'authorized', 'dispatched']
        : ['dispatched', 'authorized'];
      return transaction(pool, async (client): Promise<GitHubFinalizeWriteResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state = ANY($3::text[])
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token, allowedStates],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return { status: 'not_committed' };
        if (lease.writeCycleId && (outcome !== 'failed' || lease.dispatchedAt !== null)) {
          const cycleResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM github_identity_write_cycles
              WHERE id = $1
                AND connector_instance_id = $2
                AND mode_revision = $3
                AND state = 'running'
                AND reconciliation_state = 'unresolved'
              LIMIT 1
              FOR UPDATE
            `,
            [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
          );
          if (cycleResult.rows.length === 0) return { status: 'not_committed' };
        }
        const leaseUpdate = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = $1,
                cycle_outcome = $1,
                unknown_reason = $2,
                block_reason = $3,
                result_digest = $4,
                finalized_at = $5,
                updated_at = $5
            WHERE id = $6
              AND token = $7
              AND state = ANY($8::text[])
          `,
          [
            outcome,
            outcome === 'unknown' ? safeReason ?? 'unknown_post_dispatch_outcome' : null,
            outcome === 'failed' ? safeReason : null,
            outcome === 'succeeded' ? resultDigest : null,
            now,
            authorization.leaseId,
            authorization.token,
            allowedStates,
          ],
        );
        if (leaseUpdate.rowCount === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (await incrementCycleOutcome(client, lease.writeCycleId, outcome) !== 1) {
            throw new RollbackSignal<GitHubFinalizeWriteResult>({ status: 'outcome_lost' });
          }
        }
        if (leaseUpdate.rowCount === 1 && outcome === 'succeeded') {
          await query(
            client,
            `
              UPDATE github_identity_write_cycles
              SET reconciliation_state = 'superseded',
                  reconciliation_code = 'superseded_by_succeeded_retry',
                  reconciled_at = $1
              WHERE id IN (
                SELECT prior.write_cycle_id
                FROM task_source_write_leases AS prior
                JOIN github_write_outcome_events AS event ON event.lease_id = prior.id
                WHERE prior.connector_instance_id = $2
                  AND prior.idempotency_key = $3
                  AND prior.id != $4
                  AND prior.write_cycle_id IS NOT NULL
                  AND event.outcome = 'proven_not_applied_retryable'
              )
                AND state IN ('interrupted', 'completed')
                AND reconciliation_state = 'post_dispatch_retryable'
            `,
            [now, lease.connectorInstanceId, lease.idempotencyKey, lease.id],
          );
        }
        return { status: leaseUpdate.rowCount === 1 ? 'committed' : 'not_committed' };
      });
    },

    async blockWrite({ leaseId, token, code, now }): Promise<GitHubBlockWriteResult> {
      return transaction(pool, async (client): Promise<GitHubBlockWriteResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state IN ('claimed', 'authorized')
            LIMIT 1
            FOR UPDATE
          `,
          [leaseId, token],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return { status: 'unchanged' };
        if (lease.writeCycleId) {
          const cycleResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM github_identity_write_cycles
              WHERE id = $1
                AND connector_instance_id = $2
                AND mode_revision = $3
                AND state = 'running'
                AND reconciliation_state = 'unresolved'
              LIMIT 1
              FOR UPDATE
            `,
            [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
          );
          if (cycleResult.rows.length === 0) return { status: 'cycle_lost' };
        }
        const updateResult = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = 'blocked',
                cycle_outcome = 'blocked',
                block_reason = $1,
                finalized_at = $2,
                updated_at = $2
            WHERE id = $3
              AND token = $4
              AND state IN ('claimed', 'authorized')
          `,
          [code.slice(0, 100), now, leaseId, token],
        );
        if (updateResult.rowCount === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (await incrementCycleOutcome(client, lease.writeCycleId, 'blocked') !== 1) {
            throw new RollbackSignal<GitHubBlockWriteResult>({ status: 'outcome_lost' });
          }
        }
        return { status: updateResult.rowCount === 1 ? 'blocked' : 'unchanged' };
      });
    },

    async expireUndispatchedLeases(now) {
      const { rowCount } = await query(
        pool,
        `
          UPDATE task_source_write_leases AS lease
          SET state = 'expired',
              finalized_at = $1,
              updated_at = $1
          WHERE lease.state IN ('claimed', 'authorized')
            AND lease.dispatched_at IS NULL
            AND lease.expires_at <= $1
            AND (
              lease.write_cycle_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM github_identity_write_cycles AS cycle
                WHERE cycle.id = lease.write_cycle_id
                  AND cycle.connector_instance_id = lease.connector_instance_id
                  AND cycle.mode_revision = lease.mode_revision
                  AND cycle.state = 'running'
                  AND cycle.reconciliation_state = 'unresolved'
              )
            )
        `,
        [now],
      );
      return rowCount;
    },
  };

  return { identity, writeFence };
}
