import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/db/schema';
import {
  connectorConfigs,
  externalEntityBindings,
  githubIdentityBackfillItems,
  githubIdentityCollisions,
  githubIdentityMigrations,
  sourceLists,
  tasks,
  type ExternalBindingType,
  type GitHubBackfillState,
  type GitHubIdentityCounters,
} from '@/db/schema';
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubRestIssue,
  type GitHubRestRepository,
} from '@/lib/connectors/github-issues/github-client';
import {
  assertTrustedGitHubUrl,
  issueEvidenceFromRest,
  repositoryEvidenceFromRest,
} from '@/lib/connectors/github-issues/identity';
import {
  digestExternalIdentifier,
  persistExternalIdentityBatchInTransaction,
  updateGitHubIdentityPhaseInTransaction,
} from './service';
import { getGitHubIdentityOperatorRepository } from './worker-persistence';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
  ExternalIdentityWrite,
  ExternalIdentityWriteResult,
} from './types';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_DIAGNOSTICS = 50;
const MAX_ATTEMPTS = 5;

type ResolutionState = 'bound' | 'legacy_only' | 'inaccessible' | 'pending';

export interface GitHubIdentityBackfillResolution {
  state: ResolutionState;
  reasonCode: string;
  observedAt: string;
  evidence?: ExternalIdentityEvidence;
  nextAttemptAt?: string;
}

export interface GitHubIdentityResolver {
  resolveSourceList(sourceId: string): Promise<GitHubIdentityBackfillResolution>;
  resolveTask(row: GitHubIdentityBackfillRow): Promise<GitHubIdentityBackfillResolution>;
}

export interface GitHubIdentityBackfillRow {
  id: string;
  sourceId: string;
  metadata?: unknown;
  attemptCount?: number | null;
  nextAttemptAt?: string | null;
}

export interface GitHubIdentityBackfillOptions {
  connectorInstanceId: string;
  batchSize?: number;
  maxBatches?: number;
  dryRun?: boolean;
  resolver?: GitHubIdentityResolver;
}

export interface GitHubIdentityBackfillProgress {
  connectorInstanceId: string;
  dryRun: boolean;
  batches: number;
  processed: number;
  bound: number;
  legacyOnly: number;
  inaccessible: number;
  pending: number;
  collisions: number;
  taskCursor: string | null;
  sourceListCursor: string | null;
  completed: boolean;
  stoppedReason?: string;
}

export interface GitHubIdentityPreflightDiagnostic {
  bindingType: ExternalBindingType;
  category: 'duplicate_legacy_identity' | 'duplicate_stable_identity';
  localIds: string[];
  legacyIdentityDigest?: string;
  stableIdentityDigest?: string;
}

export interface GitHubIdentityPreflightResult {
  connectorInstanceId: string;
  hostKey: string;
  eligibleTasks: number;
  eligibleSourceLists: number;
  missingNodeMetadata: number;
  collisionCount: number;
  diagnostics: GitHubIdentityPreflightDiagnostic[];
}

export interface GitHubIdentityBackfillStatus {
  phase: string;
  taskCursor: string | null;
  sourceListCursor: string | null;
  batchSize: number;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
  counters: GitHubIdentityCounters;
}

export class GitHubIdentityBackfillResolver implements GitHubIdentityResolver {
  private readonly repositoryCache = new Map<string, Promise<GitHubIdentityBackfillResolution>>();

  constructor(private readonly client: GitHubClient) {}

  async resolveSourceList(sourceId: string): Promise<GitHubIdentityBackfillResolution> {
    return this.resolveRepository(sourceId);
  }

  async resolveTask(row: GitHubIdentityBackfillRow): Promise<GitHubIdentityBackfillResolution> {
    const parsed = parseLegacyIssueIdentity(row.sourceId);
    const observedAt = new Date().toISOString();
    if (!parsed) {
      return { state: 'legacy_only', reasonCode: 'invalid_legacy_identity', observedAt };
    }

    const repository = await this.resolveRepository(parsed.repository);
    if (repository.state !== 'bound' || !repository.evidence) return repository;
    const repositoryObservation = repository.evidence.entity;
    const metadata = parseMetadata(row.metadata);
    const metadataNodeId = typeof metadata.nodeId === 'string' && metadata.nodeId
      ? metadata.nodeId
      : null;

    if (metadataNodeId) {
      return {
        state: 'bound',
        reasonCode: 'metadata_node_id',
        observedAt,
        evidence: backfillIssueEvidence(
          metadataNodeId,
          parsed.issueNumber,
          metadata.url,
          repositoryObservation,
          this.client,
          observedAt,
        ),
      };
    }

    const response = await safeRestFetch(
      this.client,
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/issues/${parsed.issueNumber}`,
    );
    if ('resolution' in response) return response.resolution;
    const issue = await response.response.json() as GitHubRestIssue;
    const evidence = issueEvidenceFromRest(
      issue,
      repositoryObservation,
      this.client.origin,
      observedAt,
    );
    if (!evidence) {
      return { state: 'legacy_only', reasonCode: 'issue_node_id_missing', observedAt };
    }
    return {
      state: 'bound',
      reasonCode: 'rest_node_id',
      observedAt,
      evidence: asBackfillEvidence(evidence),
    };
  }

  private resolveRepository(sourceId: string): Promise<GitHubIdentityBackfillResolution> {
    const existing = this.repositoryCache.get(sourceId);
    if (existing) return existing;
    const promise = this.fetchRepository(sourceId);
    this.repositoryCache.set(sourceId, promise);
    return promise;
  }

  private async fetchRepository(sourceId: string): Promise<GitHubIdentityBackfillResolution> {
    const parsed = parseRepositoryIdentity(sourceId);
    const observedAt = new Date().toISOString();
    if (!parsed) {
      return { state: 'legacy_only', reasonCode: 'invalid_repository_identity', observedAt };
    }
    const response = await safeRestFetch(
      this.client,
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
    );
    if ('resolution' in response) return response.resolution;
    const repository = await response.response.json() as GitHubRestRepository;
    const evidence = repositoryEvidenceFromRest(repository, this.client.origin, observedAt);
    if (!evidence) {
      return { state: 'legacy_only', reasonCode: 'repository_node_id_missing', observedAt };
    }
    return {
      state: 'bound',
      reasonCode: 'repository_node_id',
      observedAt,
      evidence: { entity: { ...evidence, observationSource: 'backfill' } },
    };
  }
}

/**
 * This module ("identity backfill/status") is one of the five pre-existing,
 * previously audited GitHub worker operator/recovery surfaces (see
 * `github-worker-errors.ts`): an operator-only tool with no normal
 * HTTP/application caller. PostgreSQL does not implement it and fails closed
 * via `UnsupportedGitHubWorkerOperationError` before any SQLite import,
 * transaction, network effect, or durable mutation. The exact logic is
 * preserved bit-for-bit in the `*Sync` functions below, which are the SQLite
 * adapter's implementation (`sqlite-github-identity-operator-repositories.ts`);
 * only the database handle sourcing changed from a module-level singleton
 * import to injected parameters, so this file carries no SQLite/`@/db` import
 * of its own.
 */
export async function getGitHubIdentityBackfillStatus(
  connectorInstanceId: string,
): Promise<GitHubIdentityBackfillStatus | null> {
  return (await getGitHubIdentityOperatorRepository()).getBackfillStatus(connectorInstanceId);
}

export async function preflightGitHubIdentityBackfill(
  connectorInstanceId: string,
  persistCollisions = false,
): Promise<GitHubIdentityPreflightResult> {
  return (await getGitHubIdentityOperatorRepository())
    .preflightBackfill(connectorInstanceId, persistCollisions);
}

export async function runGitHubIdentityBackfill(
  options: GitHubIdentityBackfillOptions,
): Promise<GitHubIdentityBackfillProgress> {
  return (await getGitHubIdentityOperatorRepository()).runBackfill(options);
}

type BackfillDeps = { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> };

/**
 * SQLite-only synchronous implementation reused directly by
 * `sqlite-github-identity-operator-repositories.ts`. Must never be selected or
 * imported under PostgreSQL.
 */
export function getGitHubIdentityBackfillStatusSync(
  deps: BackfillDeps,
  connectorInstanceId: string,
): GitHubIdentityBackfillStatus | null {
  return deps.db.select()
    .from(githubIdentityMigrations)
    .where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId))
    .limit(1)
    .get() ?? null;
}

/**
 * SQLite-only synchronous implementation reused directly by
 * `sqlite-github-identity-operator-repositories.ts`. Must never be selected or
 * imported under PostgreSQL.
 */
export function preflightGitHubIdentityBackfillSync(
  deps: BackfillDeps,
  connectorInstanceId: string,
  persistCollisions = false,
): GitHubIdentityPreflightResult {
  const { sqlite, db } = deps;
  const config = loadGitHubConnectorConfig(deps, connectorInstanceId);
  const client = createGitHubClient(config.token, config.apiOrigin);
  const duplicateLegacyTasks = duplicateRows(sqlite, 'tasks', connectorInstanceId);
  const duplicateLegacyLists = duplicateRows(sqlite, 'source_lists', connectorInstanceId);
  const duplicateStableTasks = duplicateStableRows(sqlite, connectorInstanceId);
  const diagnostics: GitHubIdentityPreflightDiagnostic[] = [
    ...duplicateLegacyTasks.map((row) => ({
      bindingType: 'task' as const,
      category: 'duplicate_legacy_identity' as const,
      localIds: row.localIds,
      legacyIdentityDigest: digestExternalIdentifier(row.identity),
    })),
    ...duplicateLegacyLists.map((row) => ({
      bindingType: 'source_list' as const,
      category: 'duplicate_legacy_identity' as const,
      localIds: row.localIds,
      legacyIdentityDigest: digestExternalIdentifier(row.identity),
    })),
    ...duplicateStableTasks.map((row) => ({
      bindingType: 'task' as const,
      category: 'duplicate_stable_identity' as const,
      localIds: row.localIds,
      stableIdentityDigest: digestExternalIdentifier(row.identity),
    })),
  ].slice(0, MAX_DIAGNOSTICS);

  if (persistCollisions && diagnostics.length > 0) {
    const now = new Date().toISOString();
    db.transaction((tx) => {
      for (const diagnostic of diagnostics) {
        const fingerprint = createHash('sha256').update(JSON.stringify(diagnostic)).digest('hex');
        tx.insert(githubIdentityCollisions).values({
          id: randomUUID(),
          connectorInstanceId,
          category: diagnostic.category === 'duplicate_stable_identity'
            ? 'multiple_local_one_stable'
            : 'stable_legacy_disagree',
          fingerprint,
          bindingType: diagnostic.bindingType,
          localIds: diagnostic.localIds,
          externalEntityIds: [],
          legacyIdentityDigest: diagnostic.legacyIdentityDigest ?? diagnostic.stableIdentityDigest,
          state: 'open',
          firstSeenAt: now,
          lastSeenAt: now,
        }).onConflictDoUpdate({
          target: [
            githubIdentityCollisions.connectorInstanceId,
            githubIdentityCollisions.category,
            githubIdentityCollisions.fingerprint,
          ],
          set: { state: 'open', lastSeenAt: now, resolution: null, resolvedAt: null, resolvedBy: null },
        }).run();
      }
    }, { behavior: 'immediate' });
  }

  const eligibleTasks = db.select({ value: count() }).from(tasks)
    .where(eq(tasks.connectorInstanceId, connectorInstanceId)).get()?.value ?? 0;
  const eligibleSourceLists = db.select({ value: count() }).from(sourceLists)
    .where(eq(sourceLists.connectorInstanceId, connectorInstanceId)).get()?.value ?? 0;
  const missingNodeMetadata = sqlite.prepare(`
    SELECT COUNT(*) AS value
    FROM tasks
    WHERE connector_instance_id = ?
      AND (
        metadata IS NULL
        OR json_valid(metadata) = 0
        OR json_extract(metadata, '$.nodeId') IS NULL
      )
  `).get(connectorInstanceId) as { value: number };

  return {
    connectorInstanceId,
    hostKey: client.origin.hostKey,
    eligibleTasks,
    eligibleSourceLists,
    missingNodeMetadata: missingNodeMetadata.value,
    collisionCount: duplicateLegacyTasks.length + duplicateLegacyLists.length + duplicateStableTasks.length,
    diagnostics,
  };
}

/**
 * SQLite-only synchronous-core implementation reused directly by
 * `sqlite-github-identity-operator-repositories.ts`. Must never be selected or
 * imported under PostgreSQL. Remains genuinely `async` because it awaits
 * external GitHub REST calls through `resolver`/`safeRestFetch` between
 * synchronous, atomic SQLite transactions — exactly as the original code did.
 */
export async function runGitHubIdentityBackfillSync(
  deps: BackfillDeps,
  options: GitHubIdentityBackfillOptions,
): Promise<GitHubIdentityBackfillProgress> {
  const { sqlite, db } = deps;
  const batchSize = validateBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (
    maxBatches !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxBatches) || maxBatches <= 0)
  ) {
    throw new Error('maxBatches must be a positive integer');
  }

  const config = loadGitHubConnectorConfig(deps, options.connectorInstanceId);
  const resolver = options.resolver
    ?? new GitHubIdentityBackfillResolver(createGitHubClient(config.token, config.apiOrigin));
  const preflight = preflightGitHubIdentityBackfillSync(
    deps,
    options.connectorInstanceId,
    !options.dryRun,
  );
  if (preflight.collisionCount > 0 && !options.dryRun) {
    return emptyProgress(deps, options, 'collision_preflight_failed');
  }

  let migration = getGitHubIdentityBackfillStatusSync(deps, options.connectorInstanceId);
  if (!migration) {
    throw new Error('GitHub identity migration state is missing for this connector');
  }
  if (!options.dryRun) {
    if (!['shadow_write', 'backfilling'].includes(migration.phase)) {
      throw new Error(`Backfill cannot run while identity phase is ${migration.phase}`);
    }
    updateGitHubIdentityPhaseInTransaction(
      db,
      options.connectorInstanceId,
      'backfilling',
      new Date().toISOString(),
    );
    migration = getGitHubIdentityBackfillStatusSync(deps, options.connectorInstanceId)!;
  }

  const progress: GitHubIdentityBackfillProgress = {
    connectorInstanceId: options.connectorInstanceId,
    dryRun: options.dryRun ?? false,
    batches: 0,
    processed: 0,
    bound: 0,
    legacyOnly: 0,
    inaccessible: 0,
    pending: 0,
    collisions: 0,
    taskCursor: migration.taskCursor,
    sourceListCursor: migration.sourceListCursor,
    completed: false,
  };

  let sourceListsComplete = false;
  while (progress.batches < maxBatches) {
    const bindingType: ExternalBindingType = sourceListsComplete ? 'task' : 'source_list';
    const cursor = bindingType === 'task' ? progress.taskCursor : progress.sourceListCursor;
    const rows = selectBackfillBatch(
      db,
      options.connectorInstanceId,
      bindingType,
      cursor,
      batchSize,
    );
    if (rows.length === 0) {
      if (!sourceListsComplete) {
        sourceListsComplete = true;
        continue;
      }
      break;
    }
    const deferredRetry = rows.find((row) => (
      row.nextAttemptAt && row.nextAttemptAt > new Date().toISOString()
    ));
    if (deferredRetry) {
      progress.stoppedReason = 'retry_not_due';
      break;
    }

    const resolutions: GitHubIdentityBackfillResolution[] = [];
    let processedRowCount = rows.length;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      let resolution = bindingType === 'task'
        ? await resolver.resolveTask(row)
        : await resolver.resolveSourceList(row.sourceId);
      if (resolution.state === 'pending' && (row.attemptCount ?? 0) + 1 >= MAX_ATTEMPTS) {
        resolution = {
          state: 'inaccessible',
          reasonCode: `retry_exhausted_${resolution.reasonCode}`,
          observedAt: resolution.observedAt,
        };
      }
      resolutions.push(resolution);
      if (resolution.reasonCode === 'rate_limited') {
        processedRowCount = index + 1;
        break;
      }
    }
    const processedRows = rows.slice(0, processedRowCount);
    const batchHasPending = resolutions.some((resolution) => resolution.state === 'pending');
    applyProgress(progress, resolutions);
    progress.batches++;
    progress.processed += processedRows.length;

    if (options.dryRun) {
      const previewResults = previewIdentityBatchSync(
        db,
        writesForResolutions(
          options.connectorInstanceId,
          bindingType,
          processedRows,
          resolutions,
        ),
      );
      const previewCollisions = previewResults.filter((result) => result.state === 'collision').length;
      progress.collisions += previewCollisions;
      progress.bound -= previewCollisions;
    } else {
      const persistedCollisions = commitBackfillBatch(
        db,
        options.connectorInstanceId,
        bindingType,
        processedRows,
        resolutions,
        batchHasPending ? null : processedRows[processedRows.length - 1].id,
        batchSize,
      );
      progress.collisions += persistedCollisions;
      progress.bound -= persistedCollisions;
    }
    if (!batchHasPending) {
      if (bindingType === 'task') progress.taskCursor = processedRows[processedRows.length - 1].id;
      else progress.sourceListCursor = processedRows[processedRows.length - 1].id;
    } else {
      progress.stoppedReason = resolutions.some((resolution) => resolution.reasonCode === 'rate_limited')
        ? 'rate_limited'
        : 'retry_pending';
      break;
    }
    await yieldToEventLoop();
  }

  if (
    !options.dryRun
    && !progress.stoppedReason
    && backfillAntiJoinIsEmpty(db, options.connectorInstanceId)
  ) {
    const pending = db.select({ value: count() }).from(githubIdentityBackfillItems)
      .where(and(
        eq(githubIdentityBackfillItems.connectorInstanceId, options.connectorInstanceId),
        eq(githubIdentityBackfillItems.state, 'pending'),
      )).get()?.value ?? 0;
    if (pending === 0) {
      const now = new Date().toISOString();
      db.update(githubIdentityMigrations).set({
        completedAt: now,
        updatedAt: now,
        lastError: null,
      }).where(eq(githubIdentityMigrations.connectorInstanceId, options.connectorInstanceId)).run();
      progress.completed = true;
    }
  }
  if (!options.dryRun) refreshMigrationCounters(deps, options.connectorInstanceId, progress);
  return progress;
}

/**
 * SQLite-only synchronous dry-run preview reused directly by
 * `sqlite-github-identity-operator-repositories.ts`'s `previewIdentityBatch`
 * port method. Must never be selected or imported under PostgreSQL. Computes
 * the exact results a real write would produce by running the same write path
 * inside a transaction that is always rolled back, never persisting any
 * change — mirroring the prior Stage-1 backfill preview behavior exactly.
 */
export function previewIdentityBatchSync(
  db: BetterSQLite3Database<typeof schema>,
  writes: ExternalIdentityWrite[],
): ExternalIdentityWriteResult[] {
  if (writes.length === 0) return [];
  class RollbackSignal {
    constructor(public readonly results: ExternalIdentityWriteResult[]) {}
  }
  try {
    db.transaction((tx) => {
      const results = persistExternalIdentityBatchInTransaction(tx, writes, false);
      throw new RollbackSignal(results);
    }, { behavior: 'immediate' });
    throw new Error('Preview transaction did not roll back as expected');
  } catch (error) {
    if (error instanceof RollbackSignal) return error.results;
    throw error;
  }
}

function commitBackfillBatch(
  db: BetterSQLite3Database<typeof schema>,
  connectorInstanceId: string,
  bindingType: ExternalBindingType,
  rows: GitHubIdentityBackfillRow[],
  resolutions: GitHubIdentityBackfillResolution[],
  committedCursor: string | null,
  batchSize: number,
): number {
  return db.transaction((tx) => {
    const writes = writesForResolutions(connectorInstanceId, bindingType, rows, resolutions);
    const writeResults = persistExternalIdentityBatchInTransaction(tx, writes);
    const collisionCount = writeResults.filter((result) => result.state === 'collision').length;
    const writeByLocalId = new Map(writeResults.map((result) => [result.target.localId, result]));

    const itemRows: Array<typeof githubIdentityBackfillItems.$inferInsert> = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const resolution = resolutions[index];
      const writeResult = writeByLocalId.get(row.id);
      const state: GitHubBackfillState = writeResult?.state === 'collision'
        ? 'collision'
        : resolution.state === 'bound'
          ? 'bound'
          : resolution.state;
      itemRows.push({
        connectorInstanceId,
        bindingType,
        localId: row.id,
        state,
        externalEntityId: writeResult?.externalEntityId ?? null,
        attemptCount: 1,
        nextAttemptAt: resolution.nextAttemptAt ?? null,
        reasonCode: writeResult?.collisionCategory ?? resolution.reasonCode,
        observedAt: resolution.observedAt,
        updatedAt: resolution.observedAt,
      });
    }
    if (itemRows.length > 0) {
      tx.insert(githubIdentityBackfillItems).values(itemRows).onConflictDoUpdate({
        target: [
          githubIdentityBackfillItems.connectorInstanceId,
          githubIdentityBackfillItems.bindingType,
          githubIdentityBackfillItems.localId,
        ],
        set: {
          state: sql`excluded.state`,
          externalEntityId: sql`excluded.external_entity_id`,
          attemptCount: sql`${githubIdentityBackfillItems.attemptCount} + 1`,
          nextAttemptAt: sql`excluded.next_attempt_at`,
          reasonCode: sql`excluded.reason_code`,
          observedAt: sql`excluded.observed_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      }).run();
    }

    const now = new Date().toISOString();
    tx.update(githubIdentityMigrations).set({
      ...(committedCursor && bindingType === 'task' ? { taskCursor: committedCursor } : {}),
      ...(committedCursor && bindingType === 'source_list' ? { sourceListCursor: committedCursor } : {}),
      batchSize,
      updatedAt: now,
      lastError: committedCursor ? null : 'Backfill batch has retryable items',
    }).where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId)).run();
    return collisionCount;
  }, { behavior: 'immediate' });
}

function writesForResolutions(
  connectorInstanceId: string,
  bindingType: ExternalBindingType,
  rows: GitHubIdentityBackfillRow[],
  resolutions: GitHubIdentityBackfillResolution[],
): ExternalIdentityWrite[] {
  const writes: ExternalIdentityWrite[] = [];
  for (let index = 0; index < rows.length; index++) {
    const evidence = resolutions[index].evidence;
    if (resolutions[index].state !== 'bound' || !evidence) continue;
    writes.push({
      target: {
        connectorInstanceId,
        bindingType,
        localId: rows[index].id,
        legacyIdentity: rows[index].sourceId,
      },
      evidence,
    });
  }
  return writes;
}

function selectBackfillBatch(
  db: BetterSQLite3Database<typeof schema>,
  connectorInstanceId: string,
  bindingType: ExternalBindingType,
  cursor: string | null,
  batchSize: number,
): GitHubIdentityBackfillRow[] {
  if (bindingType === 'task') {
    return db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      metadata: tasks.metadata,
      attemptCount: githubIdentityBackfillItems.attemptCount,
      nextAttemptAt: githubIdentityBackfillItems.nextAttemptAt,
    })
      .from(tasks)
      .leftJoin(githubIdentityBackfillItems, and(
        eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId),
        eq(githubIdentityBackfillItems.bindingType, 'task'),
        eq(githubIdentityBackfillItems.localId, tasks.id),
      ))
      .where(and(
        eq(tasks.connectorInstanceId, connectorInstanceId),
        eq(tasks.connectorType, 'github-issues'),
        cursor ? gt(tasks.id, cursor) : undefined,
      ))
      .orderBy(asc(sql`${tasks.id} COLLATE BINARY`))
      .limit(batchSize)
      .all();
  }
  return db.select({
    id: sourceLists.id,
    sourceId: sourceLists.sourceId,
    attemptCount: githubIdentityBackfillItems.attemptCount,
    nextAttemptAt: githubIdentityBackfillItems.nextAttemptAt,
  })
    .from(sourceLists)
    .leftJoin(githubIdentityBackfillItems, and(
      eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityBackfillItems.bindingType, 'source_list'),
      eq(githubIdentityBackfillItems.localId, sourceLists.id),
    ))
    .where(and(
      eq(sourceLists.connectorInstanceId, connectorInstanceId),
      cursor ? gt(sourceLists.id, cursor) : undefined,
    ))
    .orderBy(asc(sql`${sourceLists.id} COLLATE BINARY`))
    .limit(batchSize)
    .all();
}

function backfillAntiJoinIsEmpty(
  db: BetterSQLite3Database<typeof schema>,
  connectorInstanceId: string,
): boolean {
  const unprocessedTask = db.select({ id: tasks.id }).from(tasks)
    .leftJoin(externalEntityBindings, and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      eq(externalEntityBindings.bindingType, 'task'),
      eq(externalEntityBindings.localId, tasks.id),
    ))
    .leftJoin(githubIdentityBackfillItems, and(
      eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityBackfillItems.bindingType, 'task'),
      eq(githubIdentityBackfillItems.localId, tasks.id),
    ))
    .where(and(
      eq(tasks.connectorInstanceId, connectorInstanceId),
      eq(tasks.connectorType, 'github-issues'),
      isNull(externalEntityBindings.id),
      isNull(githubIdentityBackfillItems.localId),
    )).limit(1).get();
  if (unprocessedTask) return false;

  return !db.select({ id: sourceLists.id }).from(sourceLists)
    .leftJoin(externalEntityBindings, and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      eq(externalEntityBindings.bindingType, 'source_list'),
      eq(externalEntityBindings.localId, sourceLists.id),
    ))
    .leftJoin(githubIdentityBackfillItems, and(
      eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityBackfillItems.bindingType, 'source_list'),
      eq(githubIdentityBackfillItems.localId, sourceLists.id),
    ))
    .where(and(
      eq(sourceLists.connectorInstanceId, connectorInstanceId),
      isNull(externalEntityBindings.id),
      isNull(githubIdentityBackfillItems.localId),
    )).limit(1).get();
}

function refreshMigrationCounters(
  deps: BackfillDeps,
  connectorInstanceId: string,
  progress: GitHubIdentityBackfillProgress,
): void {
  const { db } = deps;
  const states = db.select({
    state: githubIdentityBackfillItems.state,
    value: count(),
  }).from(githubIdentityBackfillItems)
    .where(eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId))
    .groupBy(githubIdentityBackfillItems.state)
    .all();
  const values = new Map(states.map((row) => [row.state, row.value]));
  const eligible = (db.select({ value: count() }).from(tasks)
    .where(eq(tasks.connectorInstanceId, connectorInstanceId)).get()?.value ?? 0)
    + (db.select({ value: count() }).from(sourceLists)
      .where(eq(sourceLists.connectorInstanceId, connectorInstanceId)).get()?.value ?? 0);
  const current = getGitHubIdentityBackfillStatusSync(deps, connectorInstanceId);
  const counters: GitHubIdentityCounters = {
    eligible,
    bound: values.get('bound') ?? 0,
    legacyOnly: values.get('legacy_only') ?? 0,
    inaccessible: values.get('inaccessible') ?? 0,
    pending: values.get('pending') ?? 0,
    collisions: Math.max(
      values.get('collision') ?? 0,
      db.select({ value: count() }).from(githubIdentityCollisions)
        .where(and(
          eq(githubIdentityCollisions.connectorInstanceId, connectorInstanceId),
          eq(githubIdentityCollisions.state, 'open'),
        )).get()?.value ?? 0,
    ),
    batches: (current?.counters.batches ?? 0) + progress.batches,
    retries: (current?.counters.retries ?? 0) + progress.pending,
    rateLimitPauses: (current?.counters.rateLimitPauses ?? 0)
      + (progress.stoppedReason === 'rate_limited' ? 1 : 0),
  };
  db.update(githubIdentityMigrations).set({
    counters,
    updatedAt: new Date().toISOString(),
  }).where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId)).run();
}

function loadGitHubConnectorConfig(
  deps: BackfillDeps,
  connectorInstanceId: string,
): { token: string; apiOrigin?: string } {
  const row = deps.db.select().from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.id, connectorInstanceId),
      eq(connectorConfigs.type, 'github-issues'),
      isNull(connectorConfigs.deletedAt),
    )).limit(1).get();
  if (!row) throw new Error('Active GitHub connector not found');

  const credentials = toRecord(row.credentials);
  const settings = toRecord(row.settings);
  const token = stringValue(credentials.token)
    ?? stringValue(credentials.pat)
    ?? stringValue(settings.token);
  if (!token) throw new Error('GitHub connector credentials are unavailable');
  const apiOrigin = stringValue(settings.apiOrigin);
  return {
    token,
    apiOrigin,
  };
}

async function safeRestFetch(
  client: GitHubClient,
  path: string,
): Promise<{ response: Response } | { resolution: GitHubIdentityBackfillResolution }> {
  const observedAt = new Date().toISOString();
  let response: Response;
  try {
    response = await client.restFetch(path);
  } catch {
    return {
      resolution: {
        state: 'pending',
        reasonCode: 'network_error',
        observedAt,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  }
  if (response.ok) return { response };
  const retryAt = rateLimitRetryAt(response);
  if (retryAt) {
    return {
      resolution: {
        state: 'pending',
        reasonCode: 'rate_limited',
        observedAt,
        nextAttemptAt: retryAt,
      },
    };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return {
      resolution: {
        state: 'inaccessible',
        reasonCode: response.status === 404 ? 'not_found_or_inaccessible' : 'permission_denied',
        observedAt,
      },
    };
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return {
      resolution: {
        state: 'pending',
        reasonCode: `http_${response.status}`,
        observedAt,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  }
  return {
    resolution: {
      state: 'inaccessible',
      reasonCode: `http_${response.status}`,
      observedAt,
    },
  };
}

function rateLimitRetryAt(response: Response): string | null {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = Number(retryAfterHeader);
  if (retryAfterHeader !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  return null;
}

function backfillIssueEvidence(
  stableId: string,
  issueNumber: number,
  metadataUrl: unknown,
  repository: ExternalIdentityObservation,
  client: GitHubClient,
  observedAt: string,
): ExternalIdentityEvidence {
  let webUrl: string | undefined;
  if (typeof metadataUrl === 'string') {
    try {
      webUrl = assertTrustedGitHubUrl(metadataUrl, client.origin).toString();
    } catch {
      webUrl = undefined;
    }
  }
  return {
    repository: { ...repository, observationSource: 'backfill', observedAt },
    entity: {
      identity: {
        provider: 'github',
        hostKey: client.origin.hostKey,
        entityType: 'issue',
        stableId,
      },
      locator: {
        owner: repository.locator.owner,
        repository: repository.locator.repository,
        issueNumber,
        webUrl,
      },
      observationSource: 'backfill',
      observedAt,
    },
  };
}

function asBackfillEvidence(evidence: ExternalIdentityEvidence): ExternalIdentityEvidence {
  return {
    repository: evidence.repository
      ? { ...evidence.repository, observationSource: 'backfill' }
      : undefined,
    entity: { ...evidence.entity, observationSource: 'backfill' },
  };
}

function parseLegacyIssueIdentity(
  sourceId: string,
): { repository: string; owner: string; name: string; issueNumber: number } | null {
  const separator = sourceId.lastIndexOf(':');
  if (separator <= 0) return null;
  const repository = sourceId.slice(0, separator);
  const parsedRepository = parseRepositoryIdentity(repository);
  const issueNumber = Number(sourceId.slice(separator + 1));
  if (!parsedRepository || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  return { repository, ...parsedRepository, issueNumber };
}

function parseRepositoryIdentity(sourceId: string): { owner: string; name: string } | null {
  const parts = sourceId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function duplicateRows(sqlite: Database.Database, table: 'tasks' | 'source_lists', connectorInstanceId: string) {
  return sqlite.prepare(`
    SELECT source_id AS identity, GROUP_CONCAT(id, ',') AS local_ids
    FROM ${table}
    WHERE connector_instance_id = ?
    GROUP BY source_id
    HAVING COUNT(*) > 1
    ORDER BY source_id COLLATE BINARY
    LIMIT ${MAX_DIAGNOSTICS + 1}
  `).all(connectorInstanceId).map((row) => {
    const typed = row as { identity: string; local_ids: string };
    return { identity: typed.identity, localIds: typed.local_ids.split(',').sort().slice(0, MAX_DIAGNOSTICS) };
  });
}

function duplicateStableRows(sqlite: Database.Database, connectorInstanceId: string) {
  return sqlite.prepare(`
    SELECT json_extract(metadata, '$.nodeId') AS identity, GROUP_CONCAT(id, ',') AS local_ids
    FROM tasks
    WHERE connector_instance_id = ?
      AND metadata IS NOT NULL
      AND json_valid(metadata) = 1
      AND json_extract(metadata, '$.nodeId') IS NOT NULL
    GROUP BY json_extract(metadata, '$.nodeId')
    HAVING COUNT(*) > 1
    ORDER BY identity COLLATE BINARY
    LIMIT ${MAX_DIAGNOSTICS + 1}
  `).all(connectorInstanceId).map((row) => {
    const typed = row as { identity: string; local_ids: string };
    return { identity: typed.identity, localIds: typed.local_ids.split(',').sort().slice(0, MAX_DIAGNOSTICS) };
  });
}

function validateBatchSize(batchSize: number): number {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  return batchSize;
}

function applyProgress(
  progress: GitHubIdentityBackfillProgress,
  resolutions: GitHubIdentityBackfillResolution[],
): void {
  for (const resolution of resolutions) {
    if (resolution.state === 'bound') progress.bound++;
    else if (resolution.state === 'legacy_only') progress.legacyOnly++;
    else if (resolution.state === 'inaccessible') progress.inaccessible++;
    else progress.pending++;
  }
}

function emptyProgress(
  deps: BackfillDeps,
  options: GitHubIdentityBackfillOptions,
  stoppedReason: string,
): GitHubIdentityBackfillProgress {
  const status = getGitHubIdentityBackfillStatusSync(deps, options.connectorInstanceId);
  return {
    connectorInstanceId: options.connectorInstanceId,
    dryRun: options.dryRun ?? false,
    batches: 0,
    processed: 0,
    bound: 0,
    legacyOnly: 0,
    inaccessible: 0,
    pending: 0,
    collisions: status?.counters.collisions ?? 0,
    taskCursor: status?.taskCursor ?? null,
    sourceListCursor: status?.sourceListCursor ?? null,
    completed: false,
    stoppedReason,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
