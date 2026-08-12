import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import db, { runTransaction, schema } from '@/db';
import {
  externalEntities,
  externalEntityBindings,
  externalEntityLocators,
  githubIdentityCollisions,
  githubIdentityControls,
  githubIdentityMigrations,
  type ExternalBindingState,
  type GitHubCollisionCategory,
  type GitHubIdentityPhase,
} from '@/db/schema';
import { syncLogger } from '@/lib/logger';
import type {
  ExternalEntityKey,
  ExternalEntityIdentity,
  ExternalEntityLocatorObservation,
  ExternalEntityLocatorObservationResult,
  ExternalEntityLocatorPreflight,
  ExternalEntityLocatorRecord,
  ExternalEntityLocatorEvidence,
  ExternalEntityRecord,
  ExternalEntityUpsert,
  ExternalIdentityCollisionInput,
  ExternalIdentityCollisionRecord,
  ExternalIdentityBindingTarget,
  ExternalIdentityObservation,
  ExternalIdentityWrite,
  ExternalIdentityWriteResult,
  NormalizedExternalEntityLocator,
} from './types';
import { digestExternalIdentifier } from './identifier-digest';
import type { GitHubIdentityModeSnapshot } from './comparison-types';

export { digestExternalIdentifier } from './identifier-digest';

export type ExternalIdentityTransaction = BetterSQLite3Database<typeof schema>;
type IdentityDatabase = ExternalIdentityTransaction;

const MAX_BATCH_SIZE = 500;
const MAX_COLLISION_IDS = 50;
const LOCATOR_PATH_CHUNK_SIZE = 100;
const SHADOW_WRITE_PHASES = new Set<GitHubIdentityPhase>([
  'shadow_write',
  'backfilling',
  'comparing',
  'stable_primary',
  'compatibility',
  'complete',
]);
const STAGE_ONE_PHASE_TRANSITIONS: Record<
  Extract<GitHubIdentityPhase, 'disabled' | 'schema_ready' | 'shadow_write' | 'backfilling' | 'paused'>,
  ReadonlySet<GitHubIdentityPhase>
> = {
  disabled: new Set(['disabled', 'schema_ready', 'shadow_write', 'backfilling', 'paused']),
  schema_ready: new Set(['disabled', 'schema_ready']),
  shadow_write: new Set(['schema_ready', 'shadow_write']),
  backfilling: new Set(['shadow_write', 'backfilling', 'paused']),
  paused: new Set(['backfilling', 'paused']),
};

interface PersistedEntity {
  id: string;
  identity: ExternalEntityIdentity;
}

interface LocatorResult {
  state: 'observed' | 'collision';
  category?: GitHubCollisionCategory;
  conflictingEntityId?: string;
}

interface BatchEntity extends PersistedEntity {
  nextLocatorRevision: number;
}

interface BatchLocatorObservation {
  entity: BatchEntity;
  observation: ExternalIdentityObservation;
  repositoryEntityId: string | null;
  locator: ReturnType<typeof normalizeLocator>;
}

export function createExternalEntityKey(identity: ExternalEntityIdentity): ExternalEntityKey {
  validateIdentity(identity);
  return Object.freeze({ ...identity });
}

export function getExternalEntityByKey(
  key: ExternalEntityKey,
): ExternalEntityRecord | null {
  return getExternalEntityByKeyInTransaction(db, key);
}

export function getExternalEntityByKeyInTransaction(
  database: ExternalIdentityTransaction,
  key: ExternalEntityKey,
): ExternalEntityRecord | null {
  validateIdentity(key);
  const row = database.select().from(externalEntities).where(and(
    eq(externalEntities.provider, key.provider),
    eq(externalEntities.hostKey, key.hostKey),
    eq(externalEntities.entityType, key.entityType),
    eq(externalEntities.stableId, key.stableId),
  )).limit(1).get();
  return row ? toExternalEntityRecord(row) : null;
}

export function upsertExternalEntity(
  input: ExternalEntityUpsert,
): ExternalEntityRecord {
  return runTransaction((tx) => upsertExternalEntityInTransaction(tx, input));
}

export function upsertExternalEntityInTransaction(
  database: ExternalIdentityTransaction,
  input: ExternalEntityUpsert,
): ExternalEntityRecord {
  validateIdentity(input.identity);
  if (!input.observedAt) throw new Error('External entity observation time is required');

  const { identity, observedAt } = input;
  const row = database.insert(externalEntities).values({
    id: randomUUID(),
    provider: identity.provider,
    hostKey: identity.hostKey,
    entityType: identity.entityType,
    stableId: identity.stableId,
    identityVersion: 1,
    nextLocatorRevision: 1,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
  }).onConflictDoUpdate({
    target: [
      externalEntities.provider,
      externalEntities.hostKey,
      externalEntities.entityType,
      externalEntities.stableId,
    ],
    set: {
      lastSeenAt: sql`max(${externalEntities.lastSeenAt}, excluded.last_seen_at)`,
    },
  }).returning().get();
  if (!row) throw new Error('Failed to persist external entity');
  return toExternalEntityRecord(row);
}

export function getCurrentExternalEntityLocator(
  externalEntityId: string,
): ExternalEntityLocatorRecord | null {
  return getCurrentExternalEntityLocatorInTransaction(db, externalEntityId);
}

export function getCurrentExternalEntityLocatorInTransaction(
  database: ExternalIdentityTransaction,
  externalEntityId: string,
): ExternalEntityLocatorRecord | null {
  if (!externalEntityId) throw new Error('External entity ID is required');
  const row = database.select().from(externalEntityLocators).where(and(
    eq(externalEntityLocators.externalEntityId, externalEntityId),
    isNull(externalEntityLocators.validTo),
  )).limit(1).get();
  return row ? toExternalEntityLocatorRecord(row) : null;
}

export function listExternalEntityLocatorHistory(
  externalEntityId: string,
): ExternalEntityLocatorRecord[] {
  return listExternalEntityLocatorHistoryInTransaction(db, externalEntityId);
}

export function listExternalEntityLocatorHistoryInTransaction(
  database: ExternalIdentityTransaction,
  externalEntityId: string,
): ExternalEntityLocatorRecord[] {
  if (!externalEntityId) throw new Error('External entity ID is required');
  return database.select().from(externalEntityLocators)
    .where(eq(externalEntityLocators.externalEntityId, externalEntityId))
    .orderBy(externalEntityLocators.locatorRevision)
    .all()
    .map(toExternalEntityLocatorRecord);
}

export function preflightExternalEntityLocator(
  input: ExternalEntityLocatorObservation,
): ExternalEntityLocatorPreflight {
  return preflightExternalEntityLocatorInTransaction(db, input);
}

export function preflightExternalEntityLocatorInTransaction(
  database: ExternalIdentityTransaction,
  input: ExternalEntityLocatorObservation,
): ExternalEntityLocatorPreflight {
  const entity = requireExternalEntity(database, input.entityId, input.identity);
  validateOperatorLocatorObservation(database, input);
  return evaluateLocatorPreflight(database, entity, {
    identity: input.identity,
    locator: input.locator,
    observationSource: 'operator',
    observedAt: input.observedAt,
  });
}

export function observeOperatorExternalEntityLocator(
  input: ExternalEntityLocatorObservation,
): ExternalEntityLocatorObservationResult {
  return runTransaction((tx) => observeOperatorExternalEntityLocatorInTransaction(tx, input));
}

export function observeOperatorExternalEntityLocatorInTransaction(
  database: ExternalIdentityTransaction,
  input: ExternalEntityLocatorObservation,
): ExternalEntityLocatorObservationResult {
  const entity = requireExternalEntity(database, input.entityId, input.identity);
  validateOperatorLocatorObservation(database, input);
  const observation: ExternalIdentityObservation = {
    identity: input.identity,
    locator: input.locator,
    observationSource: 'operator',
    observedAt: input.observedAt,
  };
  const preflight = evaluateLocatorPreflight(database, entity, observation);
  if (preflight.state === 'collision') {
    return { ...preflight, locatorRecord: null };
  }

  if (preflight.state === 'unchanged') {
    const current = preflight.current!;
    if (input.observedAt > current.lastSeenAt) {
      database.update(externalEntityLocators).set({
        lastSeenAt: input.observedAt,
      }).where(eq(externalEntityLocators.id, current.id)).run();
      database.update(externalEntities).set({
        lastSeenAt: sql`max(${externalEntities.lastSeenAt}, ${input.observedAt})`,
      }).where(eq(externalEntities.id, entity.id)).run();
    }
    return {
      ...preflight,
      locatorRecord: {
        ...current,
        lastSeenAt: input.observedAt > current.lastSeenAt ? input.observedAt : current.lastSeenAt,
      },
    };
  }

  const entityRow = database.select({
    nextLocatorRevision: externalEntities.nextLocatorRevision,
  }).from(externalEntities)
    .where(eq(externalEntities.id, entity.id))
    .limit(1)
    .get();
  if (!entityRow) throw new Error('External entity disappeared during locator update');

  if (preflight.current) {
    database.update(externalEntityLocators).set({
      validTo: input.observedAt,
    }).where(eq(externalEntityLocators.id, preflight.current.id)).run();
  }
  database.update(externalEntities).set({
    nextLocatorRevision: entityRow.nextLocatorRevision + 1,
    lastSeenAt: sql`max(${externalEntities.lastSeenAt}, ${input.observedAt})`,
  }).where(eq(externalEntities.id, entity.id)).run();
  const inserted = database.insert(externalEntityLocators).values({
    id: randomUUID(),
    externalEntityId: entity.id,
    repositoryEntityId: input.repositoryEntityId ?? null,
    provider: entity.identity.provider,
    hostKey: entity.identity.hostKey,
    ...preflight.locator,
    validFrom: input.observedAt,
    validTo: null,
    lastSeenAt: input.observedAt,
    observationSource: 'operator',
    locatorRevision: entityRow.nextLocatorRevision,
  }).returning().get();
  if (!inserted) throw new Error('Failed to persist external entity locator');
  return {
    ...preflight,
    locatorRecord: toExternalEntityLocatorRecord(inserted),
  };
}

export function recordExternalIdentityCollision(
  input: ExternalIdentityCollisionInput,
): ExternalIdentityCollisionRecord {
  return runTransaction((tx) => recordExternalIdentityCollisionInTransaction(tx, input));
}

export function recordExternalIdentityCollisionInTransaction(
  database: ExternalIdentityTransaction,
  input: ExternalIdentityCollisionInput,
): ExternalIdentityCollisionRecord {
  return persistCollision(database, input, true);
}

export function canWriteShadowIdentity(phase: GitHubIdentityPhase | null): boolean {
  return phase !== null && SHADOW_WRITE_PHASES.has(phase);
}

export function getGitHubIdentityPhase(connectorInstanceId: string): GitHubIdentityPhase | null {
  const row = db.select({ phase: githubIdentityMigrations.phase })
    .from(githubIdentityMigrations)
    .where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId))
    .limit(1)
    .get();
  return row?.phase ?? null;
}

export function createNewGitHubConnectorIdentityState(
  database: IdentityDatabase,
  connectorInstanceId: string,
  now: string,
): void {
  database.insert(githubIdentityMigrations).values({
    connectorInstanceId,
    phase: 'shadow_write',
    updatedAt: now,
  }).onConflictDoNothing().run();
}

export function updateGitHubIdentityPhase(
  connectorInstanceId: string,
  phase: Extract<GitHubIdentityPhase, 'disabled' | 'schema_ready' | 'shadow_write' | 'backfilling' | 'paused'>,
  now = new Date().toISOString(),
): void {
  runTransaction((tx) => {
    const current = tx.select({
      phase: githubIdentityMigrations.phase,
      startedAt: githubIdentityMigrations.startedAt,
    }).from(githubIdentityMigrations)
      .where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId))
      .limit(1)
      .get();
    if (!current) {
      throw new Error('GitHub identity migration state is missing for this connector');
    }
    if (!STAGE_ONE_PHASE_TRANSITIONS[phase].has(current.phase)) {
      throw new Error(`GitHub identity phase cannot transition from ${current.phase} to ${phase}`);
    }

    tx.update(githubIdentityMigrations).set({
      phase,
      updatedAt: now,
      ...(phase === 'backfilling'
        ? {
            startedAt: current.startedAt ?? now,
            completedAt: null,
            lastError: null,
          }
        : {}),
    }).where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId)).run();
  });
}

export function persistExternalIdentityBatch(
  writes: ExternalIdentityWrite[],
  phase: GitHubIdentityPhase | null,
  modeSnapshot?: GitHubIdentityModeSnapshot,
): ExternalIdentityWriteResult[] {
  if (writes.length === 0) return [];
  if (writes.length > MAX_BATCH_SIZE) {
    throw new Error(`External identity batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }
  if (!canWriteShadowIdentity(phase)) {
    return writes.map((write) => ({ target: write.target, state: 'skipped' }));
  }
  if (
    modeSnapshot
    && writes.some((write) =>
      write.target.connectorInstanceId !== modeSnapshot.connectorInstanceId)
  ) {
    throw new Error('External identity writes do not match the frozen connector');
  }

  const bindingState = (
    phase === 'stable_primary'
    || phase === 'compatibility'
    || phase === 'complete'
  ) ? 'active' : 'shadow';
  return runTransaction((tx) => {
    if (modeSnapshot) {
      assertGitHubIdentityModeSnapshotInTransaction(tx, modeSnapshot);
    }
    return persistExternalIdentityBatchInTransaction(tx, writes, true, bindingState);
  });
}

export function assertGitHubIdentityModeSnapshotInTransaction(
  database: IdentityDatabase,
  snapshot: GitHubIdentityModeSnapshot,
): void {
  const migration = database.select({ phase: githubIdentityMigrations.phase })
    .from(githubIdentityMigrations)
    .where(eq(githubIdentityMigrations.connectorInstanceId, snapshot.connectorInstanceId))
    .limit(1)
    .get();
  const control = database.select({
    stablePrimaryEnabled: githubIdentityControls.stablePrimaryEnabled,
    modeRevision: githubIdentityControls.modeRevision,
  }).from(githubIdentityControls)
    .where(eq(githubIdentityControls.connectorInstanceId, snapshot.connectorInstanceId))
    .limit(1)
    .get();
  const currentPhase = migration?.phase ?? null;
  const currentStable = control?.stablePrimaryEnabled ?? false;
  const currentRevision = control?.modeRevision ?? 0;
  const currentMode = currentPhase === 'comparing'
    ? 'comparison'
    : currentStable && (
        currentPhase === 'stable_primary'
        || currentPhase === 'compatibility'
        || currentPhase === 'complete'
      )
      ? 'stable'
      : 'legacy';
  if (
    currentMode !== snapshot.effectiveMode
    || currentRevision !== snapshot.modeRevision
    || currentStable !== snapshot.stablePrimaryEnabled
  ) {
    throw new Error(
      `GitHub identity mode changed from ${snapshot.effectiveMode}:${snapshot.modeRevision}`,
    );
  }
}

export function persistExternalIdentityBatchInTransaction(
  database: IdentityDatabase,
  writes: ExternalIdentityWrite[],
  emitLogs = true,
  bindingState: Extract<ExternalBindingState, 'shadow' | 'active'> = 'shadow',
): ExternalIdentityWriteResult[] {
  if (writes.length === 0) return [];
  if (writes.length > MAX_BATCH_SIZE) {
    throw new Error(`External identity batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }
  const connectorIds = new Set(writes.map((write) => write.target.connectorInstanceId));
  if (connectorIds.size !== 1) {
    throw new Error('External identity batches must contain one connector instance');
  }
  for (const write of writes) validateWrite(write);
  const fastResults = persistUnambiguousBatch(database, writes, emitLogs, bindingState);
  if (fastResults) return fastResults;
  return writes.map((write) =>
    persistExternalIdentity(database, write, emitLogs, bindingState));
}

export function previewExternalIdentityBatch(
  writes: ExternalIdentityWrite[],
): ExternalIdentityWriteResult[] {
  if (writes.length === 0) return [];
  let results: ExternalIdentityWriteResult[] = [];
  const rollback = new Error('external_identity_preview_rollback');
  try {
    runTransaction((tx) => {
      results = persistExternalIdentityBatchInTransaction(tx, writes, false);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return results;
}

function persistUnambiguousBatch(
  tx: IdentityDatabase,
  writes: ExternalIdentityWrite[],
  emitLogs: boolean,
  bindingState: Extract<ExternalBindingState, 'shadow' | 'active'>,
): ExternalIdentityWriteResult[] | null {
  if (hasInternalAmbiguity(writes)) return null;

  const observations = deduplicateObservations(writes);
  const entityRows = tx.insert(externalEntities).values(observations.map((observation) => ({
    id: randomUUID(),
    provider: observation.identity.provider,
    hostKey: observation.identity.hostKey,
    entityType: observation.identity.entityType,
    stableId: observation.identity.stableId,
    identityVersion: 1,
    nextLocatorRevision: 1,
    firstSeenAt: observation.observedAt,
    lastSeenAt: observation.observedAt,
  }))).onConflictDoUpdate({
    target: [
      externalEntities.provider,
      externalEntities.hostKey,
      externalEntities.entityType,
      externalEntities.stableId,
    ],
    set: {
      lastSeenAt: sql`max(${externalEntities.lastSeenAt}, excluded.last_seen_at)`,
    },
  }).returning({
    id: externalEntities.id,
    provider: externalEntities.provider,
    hostKey: externalEntities.hostKey,
    entityType: externalEntities.entityType,
    stableId: externalEntities.stableId,
    nextLocatorRevision: externalEntities.nextLocatorRevision,
  }).all();

  const entitiesByKey = new Map<string, BatchEntity>();
  for (const row of entityRows) {
    const identity: ExternalEntityIdentity = {
      provider: row.provider,
      hostKey: row.hostKey,
      entityType: row.entityType,
      stableId: row.stableId,
    };
    entitiesByKey.set(identityKey(identity), {
      id: row.id,
      identity,
      nextLocatorRevision: row.nextLocatorRevision,
    });
  }

  const locatorObservations: BatchLocatorObservation[] = observations.map((observation) => {
    const entity = entitiesByKey.get(identityKey(observation.identity));
    if (!entity) throw new Error('Bulk entity upsert did not return an identity');
    let repositoryEntityId: string | null = null;
    if (observation.identity.entityType === 'issue') {
      const repository = writes.find((write) => (
        identityKey(write.evidence.entity.identity) === identityKey(observation.identity)
      ))?.evidence.repository;
      if (!repository) throw new Error('Issue identity evidence requires a repository observation');
      repositoryEntityId = entitiesByKey.get(identityKey(repository.identity))?.id ?? null;
      if (!repositoryEntityId) throw new Error('Bulk repository upsert did not return an identity');
    }
    return {
      entity,
      observation,
      repositoryEntityId,
      locator: normalizeLocator(observation.locator),
    };
  });

  const currentLocators = selectInChunks(
    locatorObservations.map(({ entity }) => entity.id),
    (ids) => tx.select().from(externalEntityLocators)
      .where(and(
        inArray(externalEntityLocators.externalEntityId, ids),
        isNull(externalEntityLocators.validTo),
      )).all(),
  );
  const currentByEntityId = new Map(currentLocators.map((row) => [row.externalEntityId, row]));
  const pathConflicts = selectLocatorPathConflicts(tx, locatorObservations);
  const pathConflictByKey = new Map(pathConflicts.map((row) => [
    locatorPathKey(row.provider, row.hostKey, row.ownerKey, row.repositoryKey, row.issueNumber),
    row,
  ]));

  for (const candidate of locatorObservations) {
    const current = currentByEntityId.get(candidate.entity.id);
    candidate.locator = mergeLocatorWithCurrent(candidate.locator, current);
    if (
      current
      && candidate.observation.observedAt < current.validFrom
      && !sameLocator(current, candidate.locator)
    ) {
      return null;
    }
    const conflict = pathConflictByKey.get(locatorPathKey(
      candidate.entity.identity.provider,
      candidate.entity.identity.hostKey,
      candidate.locator.ownerKey,
      candidate.locator.repositoryKey,
      candidate.locator.issueNumber,
    ));
    if (conflict && conflict.externalEntityId !== candidate.entity.id) return null;
  }

  const connectorInstanceId = writes[0].target.connectorInstanceId;
  const localBindings = selectInChunks(
    writes.map((write) => write.target.localId),
    (ids) => tx.select().from(externalEntityBindings).where(and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      inArray(externalEntityBindings.localId, ids),
    )).all(),
  );
  const entityBindings = selectInChunks(
    writes.map((write) => {
      const entity = entitiesByKey.get(identityKey(write.evidence.entity.identity));
      if (!entity) throw new Error('Bulk entity binding lookup could not resolve identity');
      return entity.id;
    }),
    (ids) => tx.select().from(externalEntityBindings).where(and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      inArray(externalEntityBindings.externalEntityId, ids),
    )).all(),
  );
  const localBindingByKey = new Map(localBindings.map((binding) => [
    `${binding.bindingType}\0${binding.localId}`,
    binding,
  ]));
  const entityBindingByEntityId = new Map(entityBindings.map((binding) => [
    binding.externalEntityId,
    binding,
  ]));

  for (const write of writes) {
    const entity = entitiesByKey.get(identityKey(write.evidence.entity.identity))!;
    const localBinding = localBindingByKey.get(
      `${write.target.bindingType}\0${write.target.localId}`,
    );
    const entityBinding = entityBindingByEntityId.get(entity.id);
    if (
      (localBinding && localBinding.externalEntityId !== entity.id)
      || (entityBinding && (
        entityBinding.bindingType !== write.target.bindingType
        || entityBinding.localId !== write.target.localId
      ))
      || localBinding?.state === 'retired'
      || entityBinding?.state === 'retired'
    ) {
      return null;
    }
  }

  persistBatchLocators(tx, locatorObservations, currentByEntityId);
  persistBatchBindings(
    tx,
    writes,
    entitiesByKey,
    localBindingByKey,
    entityBindingByEntityId,
    bindingState,
  );

  return writes.map((write) => {
    const entity = entitiesByKey.get(identityKey(write.evidence.entity.identity))!;
    if (emitLogs) logPersistedBinding(write.target, entity);
    return {
      target: write.target,
      state: 'bound' as const,
      externalEntityId: entity.id,
    };
  });
}

function hasInternalAmbiguity(writes: ExternalIdentityWrite[]): boolean {
  const entityTargets = new Map<string, string>();
  const localEntities = new Map<string, string>();
  const entityLocators = new Map<string, string>();
  const pathEntities = new Map<string, string>();

  for (const write of writes) {
    const entityKey = identityKey(write.evidence.entity.identity);
    const localKey = `${write.target.bindingType}\0${write.target.localId}`;
    const targetKey = `${write.target.bindingType}\0${write.target.localId}`;
    if (entityTargets.has(entityKey) && entityTargets.get(entityKey) !== targetKey) return true;
    if (localEntities.has(localKey) && localEntities.get(localKey) !== entityKey) return true;
    entityTargets.set(entityKey, targetKey);
    localEntities.set(localKey, entityKey);

    for (const observation of [
      ...(write.evidence.repository ? [write.evidence.repository] : []),
      write.evidence.entity,
    ]) {
      const observationEntityKey = identityKey(observation.identity);
      const locator = normalizeLocator(observation.locator);
      const locatorKey = JSON.stringify(locator);
      const pathKey = locatorPathKey(
        observation.identity.provider,
        observation.identity.hostKey,
        locator.ownerKey,
        locator.repositoryKey,
        locator.issueNumber,
      );
      if (
        (entityLocators.has(observationEntityKey)
          && entityLocators.get(observationEntityKey) !== locatorKey)
        || (pathEntities.has(pathKey) && pathEntities.get(pathKey) !== observationEntityKey)
      ) {
        return true;
      }
      entityLocators.set(observationEntityKey, locatorKey);
      pathEntities.set(pathKey, observationEntityKey);
    }
  }
  return false;
}

function deduplicateObservations(writes: ExternalIdentityWrite[]): ExternalIdentityObservation[] {
  const observations = new Map<string, ExternalIdentityObservation>();
  for (const write of writes) {
    for (const observation of [
      ...(write.evidence.repository ? [write.evidence.repository] : []),
      write.evidence.entity,
    ]) {
      const key = identityKey(observation.identity);
      const existing = observations.get(key);
      if (!existing || observation.observedAt > existing.observedAt) {
        observations.set(key, observation);
      }
    }
  }
  return [...observations.values()];
}

function selectInChunks<T>(
  values: string[],
  select: (chunk: string[]) => T[],
): T[] {
  const uniqueValues = [...new Set(values)];
  const rows: T[] = [];
  for (let index = 0; index < uniqueValues.length; index += MAX_BATCH_SIZE) {
    rows.push(...select(uniqueValues.slice(index, index + MAX_BATCH_SIZE)));
  }
  return rows;
}

function selectLocatorPathConflicts(
  tx: IdentityDatabase,
  candidates: BatchLocatorObservation[],
): Array<{
  externalEntityId: string;
  provider: string;
  hostKey: string;
  ownerKey: string;
  repositoryKey: string;
  issueNumber: number | null;
}> {
  const rows: Array<{
    externalEntityId: string;
    provider: string;
    hostKey: string;
    ownerKey: string;
    repositoryKey: string;
    issueNumber: number | null;
  }> = [];
  for (let index = 0; index < candidates.length; index += LOCATOR_PATH_CHUNK_SIZE) {
    const clauses = candidates.slice(index, index + LOCATOR_PATH_CHUNK_SIZE).map((candidate) => and(
      eq(externalEntityLocators.provider, candidate.entity.identity.provider),
      eq(externalEntityLocators.hostKey, candidate.entity.identity.hostKey),
      eq(externalEntityLocators.ownerKey, candidate.locator.ownerKey),
      eq(externalEntityLocators.repositoryKey, candidate.locator.repositoryKey),
      candidate.locator.issueNumber === null
        ? isNull(externalEntityLocators.issueNumber)
        : eq(externalEntityLocators.issueNumber, candidate.locator.issueNumber),
    ));
    rows.push(...tx.select({
      externalEntityId: externalEntityLocators.externalEntityId,
      provider: externalEntityLocators.provider,
      hostKey: externalEntityLocators.hostKey,
      ownerKey: externalEntityLocators.ownerKey,
      repositoryKey: externalEntityLocators.repositoryKey,
      issueNumber: externalEntityLocators.issueNumber,
    }).from(externalEntityLocators).where(and(
      isNull(externalEntityLocators.validTo),
      or(...clauses),
    )).all());
  }
  return rows;
}

function persistBatchLocators(
  tx: IdentityDatabase,
  candidates: BatchLocatorObservation[],
  currentByEntityId: Map<string, typeof externalEntityLocators.$inferSelect>,
): void {
  const identical: Array<{
    id: string;
    observedAt: string;
  }> = [];
  const changed: Array<{
    id: string;
    observedAt: string;
  }> = [];
  const inserted: Array<typeof externalEntityLocators.$inferInsert> = [];
  const revisionUpdates: Array<{
    id: string;
    nextLocatorRevision: number;
    observedAt: string;
  }> = [];

  for (const candidate of candidates) {
    const current = currentByEntityId.get(candidate.entity.id);
    if (current && sameLocator(current, candidate.locator)) {
      if (candidate.observation.observedAt > current.lastSeenAt) {
        identical.push({ id: current.id, observedAt: candidate.observation.observedAt });
      }
      continue;
    }
    if (current) {
      changed.push({ id: current.id, observedAt: candidate.observation.observedAt });
    }
    revisionUpdates.push({
      id: candidate.entity.id,
      nextLocatorRevision: candidate.entity.nextLocatorRevision + 1,
      observedAt: candidate.observation.observedAt,
    });
    inserted.push({
      id: randomUUID(),
      externalEntityId: candidate.entity.id,
      repositoryEntityId: candidate.repositoryEntityId,
      provider: candidate.entity.identity.provider,
      hostKey: candidate.entity.identity.hostKey,
      owner: candidate.locator.owner,
      repository: candidate.locator.repository,
      ownerKey: candidate.locator.ownerKey,
      repositoryKey: candidate.locator.repositoryKey,
      issueNumber: candidate.locator.issueNumber,
      apiUrl: candidate.locator.apiUrl,
      webUrl: candidate.locator.webUrl,
      validFrom: candidate.observation.observedAt,
      validTo: null,
      lastSeenAt: candidate.observation.observedAt,
      observationSource: candidate.observation.observationSource,
      locatorRevision: candidate.entity.nextLocatorRevision,
    });
  }

  updateTextById(tx, externalEntityLocators, externalEntityLocators.lastSeenAt, identical);
  updateTextById(tx, externalEntityLocators, externalEntityLocators.validTo, changed);
  updateEntityRevisions(tx, revisionUpdates);
  if (inserted.length > 0) tx.insert(externalEntityLocators).values(inserted).run();
}

function persistBatchBindings(
  tx: IdentityDatabase,
  writes: ExternalIdentityWrite[],
  entitiesByKey: Map<string, BatchEntity>,
  localBindingByKey: Map<string, typeof externalEntityBindings.$inferSelect>,
  entityBindingByEntityId: Map<string, typeof externalEntityBindings.$inferSelect>,
  bindingState: Extract<ExternalBindingState, 'shadow' | 'active'>,
): void {
  const inserts: Array<typeof externalEntityBindings.$inferInsert> = [];
  const updates = new Map<string, string>();
  for (const write of writes) {
    const entity = entitiesByKey.get(identityKey(write.evidence.entity.identity))!;
    const existing = localBindingByKey.get(
      `${write.target.bindingType}\0${write.target.localId}`,
    ) ?? entityBindingByEntityId.get(entity.id);
    if (existing) {
      const previous = updates.get(existing.id);
      if (!previous || write.evidence.entity.observedAt > previous) {
        updates.set(existing.id, write.evidence.entity.observedAt);
      }
      continue;
    }
    inserts.push({
      id: randomUUID(),
      externalEntityId: entity.id,
      connectorInstanceId: write.target.connectorInstanceId,
      bindingType: write.target.bindingType,
      localId: write.target.localId,
      state: bindingState,
      verifiedAt: write.evidence.entity.observedAt,
      createdAt: write.evidence.entity.observedAt,
      updatedAt: write.evidence.entity.observedAt,
    });
  }
  if (inserts.length > 0) tx.insert(externalEntityBindings).values(inserts).run();
  updateBindingTimestamps(tx, [...updates].map(([id, observedAt]) => ({ id, observedAt })));
}

function updateTextById(
  tx: IdentityDatabase,
  table: typeof externalEntityLocators,
  column: typeof externalEntityLocators.lastSeenAt | typeof externalEntityLocators.validTo,
  updates: Array<{ id: string; observedAt: string }>,
): void {
  if (updates.length === 0) return;
  const expression = sql.join([
    sql`CASE`,
    ...updates.map((update) => sql`WHEN ${table.id} = ${update.id} THEN ${update.observedAt}`),
    sql`ELSE ${column} END`,
  ], sql.raw(' '));
  const predicate = inArray(table.id, updates.map((update) => update.id));
  if (column === externalEntityLocators.lastSeenAt) {
    tx.update(table).set({ lastSeenAt: expression }).where(predicate).run();
  } else {
    tx.update(table).set({ validTo: expression }).where(predicate).run();
  }
}

function updateEntityRevisions(
  tx: IdentityDatabase,
  updates: Array<{ id: string; nextLocatorRevision: number; observedAt: string }>,
): void {
  if (updates.length === 0) return;
  const revisionExpression = sql.join([
    sql`CASE`,
    ...updates.map((update) => (
      sql`WHEN ${externalEntities.id} = ${update.id} THEN ${update.nextLocatorRevision}`
    )),
    sql`ELSE ${externalEntities.nextLocatorRevision} END`,
  ], sql.raw(' '));
  const lastSeenExpression = sql.join([
    sql`CASE`,
    ...updates.map((update) => sql`WHEN ${externalEntities.id} = ${update.id} THEN max(${externalEntities.lastSeenAt}, ${update.observedAt})`),
    sql`ELSE ${externalEntities.lastSeenAt} END`,
  ], sql.raw(' '));
  tx.update(externalEntities).set({
    nextLocatorRevision: revisionExpression,
    lastSeenAt: lastSeenExpression,
  }).where(inArray(externalEntities.id, updates.map((update) => update.id))).run();
}

function updateBindingTimestamps(
  tx: IdentityDatabase,
  updates: Array<{ id: string; observedAt: string }>,
): void {
  if (updates.length === 0) return;
  const expression = sql.join([
    sql`CASE`,
    ...updates.map((update) => (
      sql`WHEN ${externalEntityBindings.id} = ${update.id} THEN ${update.observedAt}`
    )),
    sql`ELSE ${externalEntityBindings.updatedAt} END`,
  ], sql.raw(' '));
  tx.update(externalEntityBindings).set({
    verifiedAt: expression,
    updatedAt: expression,
  }).where(inArray(
    externalEntityBindings.id,
    updates.map((update) => update.id),
  )).run();
}

function identityKey(identity: ExternalEntityIdentity): string {
  return `${identity.provider}\0${identity.hostKey}\0${identity.entityType}\0${identity.stableId}`;
}

function locatorPathKey(
  provider: string,
  hostKey: string,
  ownerKey: string,
  repositoryKey: string,
  issueNumber: number | null,
): string {
  return `${provider}\0${hostKey}\0${ownerKey}\0${repositoryKey}\0${issueNumber ?? ''}`;
}

function mergeLocatorWithCurrent(
  locator: ReturnType<typeof normalizeLocator>,
  current: typeof externalEntityLocators.$inferSelect | undefined,
): ReturnType<typeof normalizeLocator> {
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

function logPersistedBinding(
  target: ExternalIdentityBindingTarget,
  entity: PersistedEntity,
): void {
  syncLogger.debug({
    connectorId: target.connectorInstanceId,
    bindingType: target.bindingType,
    localId: target.localId,
    provider: entity.identity.provider,
    hostKey: entity.identity.hostKey,
    entityType: entity.identity.entityType,
    stableIdDigest: digestExternalIdentifier(entity.identity.stableId),
  }, 'Persisted external identity shadow binding');
}

function persistExternalIdentity(
  tx: IdentityDatabase,
  write: ExternalIdentityWrite,
  emitLogs: boolean,
  bindingState: Extract<ExternalBindingState, 'shadow' | 'active'>,
): ExternalIdentityWriteResult {
  validateWrite(write);
  const { target, evidence } = write;

  let repositoryEntity: PersistedEntity | null = null;
  if (evidence.entity.identity.entityType === 'issue') {
    if (!evidence.repository) {
      throw new Error('Issue identity evidence requires a repository observation');
    }
    repositoryEntity = upsertEntity(tx, evidence.repository);
    const repositoryLocator = observeLocator(tx, repositoryEntity, evidence.repository, null);
    if (repositoryLocator.state === 'collision') {
      return recordWriteCollision(
        tx,
        target,
        repositoryLocator.category!,
        [repositoryEntity.id, repositoryLocator.conflictingEntityId!],
        evidence.repository.observedAt,
        undefined,
        emitLogs,
      );
    }
  }

  const entity = upsertEntity(tx, evidence.entity);
  const localBinding = tx.select()
    .from(externalEntityBindings)
    .where(and(
      eq(externalEntityBindings.connectorInstanceId, target.connectorInstanceId),
      eq(externalEntityBindings.bindingType, target.bindingType),
      eq(externalEntityBindings.localId, target.localId),
    ))
    .limit(1)
    .get();
  const entityBinding = tx.select()
    .from(externalEntityBindings)
    .where(and(
      eq(externalEntityBindings.connectorInstanceId, target.connectorInstanceId),
      eq(externalEntityBindings.externalEntityId, entity.id),
    ))
    .limit(1)
    .get();

  if (localBinding && localBinding.externalEntityId !== entity.id) {
    return recordWriteCollision(
      tx,
      target,
      'one_local_multiple_stable',
      [localBinding.externalEntityId, entity.id],
      evidence.entity.observedAt,
      undefined,
      emitLogs,
    );
  }
  if (entityBinding && (
    entityBinding.bindingType !== target.bindingType
    || entityBinding.localId !== target.localId
  )) {
    return recordWriteCollision(
      tx,
      target,
      'multiple_local_one_stable',
      [entity.id],
      evidence.entity.observedAt,
      [entityBinding.localId, target.localId],
      emitLogs,
    );
  }
  if (localBinding?.state === 'retired' || entityBinding?.state === 'retired') {
    return recordWriteCollision(
      tx,
      target,
      'stable_legacy_disagree',
      [entity.id],
      evidence.entity.observedAt,
      undefined,
      emitLogs,
    );
  }

  const locatorResult = observeLocator(tx, entity, evidence.entity, repositoryEntity?.id ?? null);
  if (locatorResult.state === 'collision') {
    return recordWriteCollision(
      tx,
      target,
      locatorResult.category!,
      [entity.id, locatorResult.conflictingEntityId!],
      evidence.entity.observedAt,
      undefined,
      emitLogs,
    );
  }

  const existingBinding = localBinding ?? entityBinding;
  if (existingBinding) {
    tx.update(externalEntityBindings).set({
      verifiedAt: evidence.entity.observedAt,
      updatedAt: evidence.entity.observedAt,
    }).where(eq(externalEntityBindings.id, existingBinding.id)).run();
  } else {
    tx.insert(externalEntityBindings).values({
      id: randomUUID(),
      externalEntityId: entity.id,
      connectorInstanceId: target.connectorInstanceId,
      bindingType: target.bindingType,
      localId: target.localId,
      state: bindingState,
      verifiedAt: evidence.entity.observedAt,
      createdAt: evidence.entity.observedAt,
      updatedAt: evidence.entity.observedAt,
    }).run();
  }

  if (emitLogs) logPersistedBinding(target, entity);

  return {
    target,
    state: 'bound',
    externalEntityId: entity.id,
  };
}

function validateWrite(write: ExternalIdentityWrite): void {
  const { target, evidence } = write;
  if (!target.connectorInstanceId || !target.localId || !target.legacyIdentity) {
    throw new Error('External identity binding target is incomplete');
  }
  validateObservation(evidence.entity);
  if (target.bindingType === 'task' && evidence.entity.identity.entityType !== 'issue') {
    throw new Error('Task bindings require issue identity evidence');
  }
  if (target.bindingType === 'source_list' && evidence.entity.identity.entityType !== 'repository') {
    throw new Error('Source-list bindings require repository identity evidence');
  }
  if (evidence.repository) {
    validateObservation(evidence.repository);
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
}

function validateObservation(observation: ExternalIdentityObservation): void {
  const { identity, locator } = observation;
  validateIdentity(identity);
  if (
    !locator.owner
    || !locator.repository
  ) {
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

function validateIdentity(identity: ExternalEntityIdentity): void {
  if (!identity.provider || !identity.hostKey || !identity.stableId) {
    throw new Error('External entity key is incomplete');
  }
  if (identity.entityType !== 'repository' && identity.entityType !== 'issue') {
    throw new Error('External entity type is invalid');
  }
}

function upsertEntity(
  tx: IdentityDatabase,
  observation: ExternalIdentityObservation,
): PersistedEntity {
  return upsertExternalEntityInTransaction(tx, {
    identity: observation.identity,
    observedAt: observation.observedAt,
  });
}

function requireExternalEntity(
  database: ExternalIdentityTransaction,
  entityId: string,
  identity: ExternalEntityIdentity,
): ExternalEntityRecord {
  if (!entityId) throw new Error('External entity ID is required');
  validateIdentity(identity);
  const row = database.select().from(externalEntities)
    .where(eq(externalEntities.id, entityId))
    .limit(1)
    .get();
  if (!row) throw new Error('External entity was not found');
  const entity = toExternalEntityRecord(row);
  if (identityKey(entity.identity) !== identityKey(identity)) {
    throw new Error('External entity ID does not match the supplied key');
  }
  return entity;
}

function validateOperatorLocatorObservation(
  database: ExternalIdentityTransaction,
  input: ExternalEntityLocatorObservation,
): void {
  validateObservation({
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
  const repository = database.select().from(externalEntities)
    .where(eq(externalEntities.id, repositoryEntityId))
    .limit(1)
    .get();
  if (
    !repository
    || repository.entityType !== 'repository'
    || repository.provider !== input.identity.provider
    || repository.hostKey !== input.identity.hostKey
  ) {
    throw new Error('Issue locator repository entity does not match its provider and host');
  }
}

function evaluateLocatorPreflight(
  database: ExternalIdentityTransaction,
  entity: PersistedEntity,
  observation: ExternalIdentityObservation,
): ExternalEntityLocatorPreflight {
  let locator = normalizeLocator(observation.locator);
  const currentRow = database.select().from(externalEntityLocators)
    .where(and(
      eq(externalEntityLocators.externalEntityId, entity.id),
      isNull(externalEntityLocators.validTo),
    ))
    .limit(1)
    .get();
  locator = mergeLocatorWithCurrent(locator, currentRow);
  const current = currentRow ? toExternalEntityLocatorRecord(currentRow) : null;

  if (
    currentRow
    && observation.observedAt < currentRow.validFrom
    && !sameLocator(currentRow, locator)
  ) {
    return {
      state: 'collision',
      locator,
      current,
      collisionCategory: 'locator_overlap_or_regression',
      conflictingEntityId: entity.id,
    };
  }
  if (currentRow && sameLocator(currentRow, locator)) {
    return { state: 'unchanged', locator, current };
  }

  const pathConflict = database.select({
    externalEntityId: externalEntityLocators.externalEntityId,
  }).from(externalEntityLocators).where(and(
    eq(externalEntityLocators.provider, entity.identity.provider),
    eq(externalEntityLocators.hostKey, entity.identity.hostKey),
    eq(externalEntityLocators.ownerKey, locator.ownerKey),
    eq(externalEntityLocators.repositoryKey, locator.repositoryKey),
    locator.issueNumber === null
      ? isNull(externalEntityLocators.issueNumber)
      : eq(externalEntityLocators.issueNumber, locator.issueNumber),
    isNull(externalEntityLocators.validTo),
  )).limit(1).get();
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

function observeLocator(
  tx: IdentityDatabase,
  entity: PersistedEntity,
  observation: ExternalIdentityObservation,
  repositoryEntityId: string | null,
): LocatorResult {
  let locator = normalizeLocator(observation.locator);
  const current = tx.select()
    .from(externalEntityLocators)
    .where(and(
      eq(externalEntityLocators.externalEntityId, entity.id),
      isNull(externalEntityLocators.validTo),
    ))
    .limit(1)
    .get();

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

  if (current && observation.observedAt < current.validFrom && !sameLocator(current, locator)) {
    return {
      state: 'collision',
      category: 'locator_overlap_or_regression',
      conflictingEntityId: entity.id,
    };
  }

  if (current && sameLocator(current, locator)) {
    if (observation.observedAt > current.lastSeenAt) {
      tx.update(externalEntityLocators).set({
        lastSeenAt: observation.observedAt,
      }).where(eq(externalEntityLocators.id, current.id)).run();
    }
    return { state: 'observed' };
  }

  const pathConflict = tx.select({
    externalEntityId: externalEntityLocators.externalEntityId,
  }).from(externalEntityLocators).where(and(
    eq(externalEntityLocators.provider, entity.identity.provider),
    eq(externalEntityLocators.hostKey, entity.identity.hostKey),
    eq(externalEntityLocators.ownerKey, locator.ownerKey),
    eq(externalEntityLocators.repositoryKey, locator.repositoryKey),
    locator.issueNumber === null
      ? isNull(externalEntityLocators.issueNumber)
      : eq(externalEntityLocators.issueNumber, locator.issueNumber),
    isNull(externalEntityLocators.validTo),
  )).limit(1).get();

  if (pathConflict && pathConflict.externalEntityId !== entity.id) {
    return {
      state: 'collision',
      category: entity.identity.entityType === 'repository'
        ? 'repository_path_replacement'
        : 'stable_legacy_disagree',
      conflictingEntityId: pathConflict.externalEntityId,
    };
  }

  const entityRow = tx.select({
    nextLocatorRevision: externalEntities.nextLocatorRevision,
  }).from(externalEntities)
    .where(eq(externalEntities.id, entity.id))
    .limit(1)
    .get();
  if (!entityRow) throw new Error('External entity disappeared during locator update');

  if (current) {
    tx.update(externalEntityLocators).set({
      validTo: observation.observedAt,
    }).where(eq(externalEntityLocators.id, current.id)).run();
  }
  tx.update(externalEntities).set({
    nextLocatorRevision: entityRow.nextLocatorRevision + 1,
    lastSeenAt: observation.observedAt,
  }).where(eq(externalEntities.id, entity.id)).run();
  tx.insert(externalEntityLocators).values({
    id: randomUUID(),
    externalEntityId: entity.id,
    repositoryEntityId,
    provider: entity.identity.provider,
    hostKey: entity.identity.hostKey,
    owner: locator.owner,
    repository: locator.repository,
    ownerKey: locator.ownerKey,
    repositoryKey: locator.repositoryKey,
    issueNumber: locator.issueNumber,
    apiUrl: locator.apiUrl,
    webUrl: locator.webUrl,
    validFrom: observation.observedAt,
    validTo: null,
    lastSeenAt: observation.observedAt,
    observationSource: observation.observationSource,
    locatorRevision: entityRow.nextLocatorRevision,
  }).run();
  return { state: 'observed' };
}

export function normalizeExternalEntityLocator(
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

function normalizeLocator(
  locator: ExternalEntityLocatorEvidence,
): NormalizedExternalEntityLocator {
  return normalizeExternalEntityLocator(locator);
}

function toExternalEntityRecord(
  row: typeof externalEntities.$inferSelect,
): ExternalEntityRecord {
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

function toExternalEntityLocatorRecord(
  row: typeof externalEntityLocators.$inferSelect,
): ExternalEntityLocatorRecord {
  return {
    id: row.id,
    externalEntityId: row.externalEntityId,
    repositoryEntityId: row.repositoryEntityId,
    owner: row.owner,
    repository: row.repository,
    ownerKey: row.ownerKey,
    repositoryKey: row.repositoryKey,
    issueNumber: row.issueNumber,
    apiUrl: row.apiUrl,
    webUrl: row.webUrl,
    validFrom: row.validFrom,
    validTo: row.validTo,
    lastSeenAt: row.lastSeenAt,
    observationSource: row.observationSource,
    locatorRevision: row.locatorRevision,
  };
}

function sameLocator(
  current: typeof externalEntityLocators.$inferSelect,
  locator: ReturnType<typeof normalizeLocator>,
): boolean {
  return current.owner === locator.owner
    && current.repository === locator.repository
    && current.ownerKey === locator.ownerKey
    && current.repositoryKey === locator.repositoryKey
    && current.issueNumber === locator.issueNumber
    && current.apiUrl === locator.apiUrl
    && current.webUrl === locator.webUrl;
}

function recordWriteCollision(
  tx: IdentityDatabase,
  target: ExternalIdentityBindingTarget,
  category: GitHubCollisionCategory,
  externalEntityIds: string[],
  observedAt: string,
  localIds = [target.localId],
  emitLogs = true,
): ExternalIdentityWriteResult {
  persistCollision(tx, {
    connectorInstanceId: target.connectorInstanceId,
    category,
    bindingType: target.bindingType,
    localIds,
    externalEntityIds,
    legacyIdentity: target.legacyIdentity,
    observedAt,
  }, emitLogs);

  return {
    target,
    state: 'collision',
    collisionCategory: category,
  };
}

function persistCollision(
  database: ExternalIdentityTransaction,
  input: ExternalIdentityCollisionInput,
  emitLogs: boolean,
): ExternalIdentityCollisionRecord {
  if (!input.connectorInstanceId || !input.observedAt) {
    throw new Error('External identity collision context is incomplete');
  }
  if (input.localIds.length === 0 || input.externalEntityIds.length === 0) {
    throw new Error('External identity collision requires local and entity IDs');
  }
  const boundedLocalIds = boundedSorted(input.localIds);
  const boundedEntityIds = boundedSorted(input.externalEntityIds);
  const fingerprint = digestExternalIdentifier(JSON.stringify({
    category: input.category,
    bindingType: input.bindingType,
    localIds: boundedLocalIds,
    externalEntityIds: boundedEntityIds,
  }));
  const legacyIdentityDigest = input.legacyIdentity
    ? digestExternalIdentifier(input.legacyIdentity)
    : null;

  const row = database.insert(githubIdentityCollisions).values({
    id: randomUUID(),
    connectorInstanceId: input.connectorInstanceId,
    category: input.category,
    fingerprint,
    bindingType: input.bindingType,
    localIds: boundedLocalIds,
    externalEntityIds: boundedEntityIds,
    legacyIdentityDigest,
    state: 'open',
    resolution: null,
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
    resolvedAt: null,
    resolvedBy: null,
  }).onConflictDoUpdate({
    target: [
      githubIdentityCollisions.connectorInstanceId,
      githubIdentityCollisions.category,
      githubIdentityCollisions.fingerprint,
    ],
    set: {
      localIds: boundedLocalIds,
      externalEntityIds: boundedEntityIds,
      legacyIdentityDigest,
      state: 'open',
      resolution: null,
      lastSeenAt: input.observedAt,
      resolvedAt: null,
      resolvedBy: null,
    },
  }).returning().get();
  if (!row) throw new Error('Failed to record external identity collision');

  markBindingsCollision(
    database,
    input.connectorInstanceId,
    input.bindingType,
    boundedLocalIds,
    boundedEntityIds,
    input.observedAt,
  );

  if (emitLogs) {
    syncLogger.warn({
      connectorId: input.connectorInstanceId,
      bindingType: input.bindingType,
      localIds: boundedLocalIds,
      category: input.category,
      collisionFingerprint: fingerprint,
      legacyIdentityDigest,
    }, 'External identity collision recorded');
  }

  return {
    id: row.id,
    connectorInstanceId: row.connectorInstanceId,
    category: row.category,
    fingerprint: row.fingerprint,
    bindingType: row.bindingType,
    localIds: row.localIds,
    externalEntityIds: row.externalEntityIds,
    legacyIdentityDigest: row.legacyIdentityDigest,
    state: row.state,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function markBindingsCollision(
  tx: IdentityDatabase,
  connectorInstanceId: string,
  bindingType: ExternalIdentityBindingTarget['bindingType'],
  localIds: string[],
  externalEntityIds: string[],
  observedAt: string,
): void {
  for (const localId of localIds) {
    const binding = tx.select({ id: externalEntityBindings.id, state: externalEntityBindings.state })
      .from(externalEntityBindings)
      .where(and(
        eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
        eq(externalEntityBindings.bindingType, bindingType),
        eq(externalEntityBindings.localId, localId),
      ))
      .limit(1)
      .get();
    transitionBindingToCollision(tx, binding, observedAt);
  }
  for (const externalEntityId of externalEntityIds) {
    const binding = tx.select({ id: externalEntityBindings.id, state: externalEntityBindings.state })
      .from(externalEntityBindings)
      .where(and(
        eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
        eq(externalEntityBindings.externalEntityId, externalEntityId),
      ))
      .limit(1)
      .get();
    transitionBindingToCollision(tx, binding, observedAt);
  }
}

function transitionBindingToCollision(
  tx: IdentityDatabase,
  binding: { id: string; state: ExternalBindingState } | undefined,
  observedAt: string,
): void {
  if (!binding || binding.state === 'retired') return;
  tx.update(externalEntityBindings).set({
    state: 'collision',
    updatedAt: observedAt,
  }).where(eq(externalEntityBindings.id, binding.id)).run();
}

function boundedSorted(values: string[]): string[] {
  return [...new Set(values)].sort().slice(0, MAX_COLLISION_IDS);
}
