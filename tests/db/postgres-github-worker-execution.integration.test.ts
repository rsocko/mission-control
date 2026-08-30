import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresConnectorExecutionRepositories,
  createPostgresGitHubWorkerRepositories,
} from '@/db/postgres/repositories';
import { PostgresSyncJobRepository } from '@/db/postgres/sync/job-repository';
import { PostgresSyncRunRepository } from '@/db/postgres/repositories/sync-run-repository';
import type {
  GitHubFenceTaskRow,
  GitHubWriteIdentity,
} from '@/db/persistence/github-identity';
import type {
  DependencySnapshotFence,
  DependencySnapshotRecord,
  TaskDependencyInsert,
} from '@/db/persistence/github-dependencies';
import type {
  GitHubHierarchyReconcileContext,
  GitHubHierarchyTaskUpdate,
} from '@/db/persistence/github-hierarchy';
import type { GitHubProjectReconciliation } from '@/db/persistence/github-projects';
import { dependencySnapshotRecord } from '../contracts/github-dependency-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

/**
 * End-to-end live-PostgreSQL smoke for the "Layer 3A" GitHub queue-execution
 * persistence composed as {@link createPostgresGitHubWorkerRepositories}
 * (identity / writeFence / dependencies / hierarchy / projects) plus the generic
 * Layer 2 connector-execution adapter and {@link PostgresSyncJobRepository}.
 *
 * Every GitHub identifier below is an inert synthetic NodeID-like value
 * (`I_kwSYNTHETIC…`, `R_kgSYNTHETIC…`, `synthetic-owner/synthetic-repo`). Nothing
 * resembles a real node id or repository, and the test performs no network call.
 *
 * When `MC_TEST_POSTGRES_URL` is unset the whole file still registers a suite and
 * skips (the placeholder below keeps vitest from reporting "No test suite found").
 */
const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-worker-execution-test',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

// Fixed identity timestamps (fence freshness compares EXPIRES > LATER > NOW).
const NOW = '2026-08-30T12:00:00.000Z';
const LATER = '2026-08-30T12:05:00.000Z';
const EXPIRES = '2026-08-30T12:30:00.000Z';
const MODE_REVISION = 4;

interface WorkerIds {
  connectorId: string;
  taskId: string;
  parentTaskId: string;
  childTaskId: string;
  blockerTaskId: string;
  blockedTaskId: string;
  sourceListId: string;
  sourceId: string;
  blockerSourceId: string;
  blockedSourceId: string;
  repoEntityId: string;
  issueEntityId: string;
  repoStableId: string;
  issueStableId: string;
  linkedSourceId: string;
}

function makeIds(): WorkerIds {
  const connectorId = `gh-worker-${randomUUID()}`;
  const frag = connectorId.slice(-12);
  return {
    connectorId,
    taskId: `${connectorId}:task`,
    parentTaskId: `${connectorId}:parent`,
    childTaskId: `${connectorId}:child`,
    blockerTaskId: `${connectorId}:blocker`,
    blockedTaskId: `${connectorId}:blocked`,
    sourceListId: `${connectorId}:repo-list`,
    sourceId: 'synthetic-owner/synthetic-repo:7',
    blockerSourceId: 'synthetic-owner/synthetic-repo:8',
    blockedSourceId: 'synthetic-owner/synthetic-repo:9',
    repoEntityId: `${connectorId}:repo-entity`,
    issueEntityId: `${connectorId}:issue-entity`,
    repoStableId: `R_kgSYNTHETIC${frag}`,
    issueStableId: `I_kwSYNTHETIC${frag}`,
    linkedSourceId: `${connectorId}:link-1`,
  };
}

function deriveUpdateIdentity(task: GitHubFenceTaskRow): GitHubWriteIdentity {
  return {
    idempotencyKey: `idem:${task.id}:update`,
    intent: { kind: 'update', digest: 'digest-1' },
    initialCreate: false,
  };
}

/** Applies the whole re-read population as parent/depth/metadata updates. */
function updatesFrom(
  context: GitHubHierarchyReconcileContext,
  desired: ReadonlyMap<
    string,
    { parentId: string | null; depth: number; githubParent?: Record<string, unknown> }
  >,
): readonly GitHubHierarchyTaskUpdate[] {
  const updates: GitHubHierarchyTaskUpdate[] = [];
  for (const task of context.tasks) {
    const target = desired.get(task.id);
    if (!target) continue;
    const update: GitHubHierarchyTaskUpdate = {
      taskId: task.id,
      parentId: target.parentId,
      depth: target.depth,
    };
    if (target.githubParent !== undefined) {
      const existing =
        task.metadata && typeof task.metadata === 'object'
          ? (task.metadata as Record<string, unknown>)
          : {};
      update.metadata = { ...existing, githubParent: target.githubParent };
    }
    updates.push(update);
  }
  return updates;
}

function depSnapshot(
  connectorId: string,
  overrides: Partial<DependencySnapshotRecord> & { id: string },
): DependencySnapshotRecord {
  return dependencySnapshotRecord({
    connectorInstanceId: connectorId,
    identityModeRevision: MODE_REVISION,
    ...overrides,
  });
}

function fenceOf(record: DependencySnapshotRecord): DependencySnapshotFence {
  return {
    id: record.id,
    connectorInstanceId: record.connectorInstanceId,
    identityMode: record.identityMode,
    identityModeRevision: record.identityModeRevision,
  };
}

function depInsert(
  connectorId: string,
  row: { id: string; taskId: string; dependsOnTaskId: string },
): TaskDependencyInsert {
  return {
    id: row.id,
    taskId: row.taskId,
    dependsOnTaskId: row.dependsOnTaskId,
    type: 'blocks',
    connectorInstanceId: connectorId,
    syncStatus: 'synced',
    syncAction: null,
    syncError: null,
    lastSyncedAt: NOW,
    createdAt: NOW,
  };
}

function reconciliation(
  connectorId: string,
  overrides: Partial<GitHubProjectReconciliation> & { number: number },
): GitHubProjectReconciliation {
  return {
    name: `Project ${overrides.number}`,
    description: `Description ${overrides.number}`,
    url: `https://github.com/orgs/synthetic-owner/projects/${overrides.number}`,
    authoritative: true,
    taskSourceIds: [],
    useStableRouting: false,
    resolveIdentityDigest: () => `synthetic-digest-${connectorId}-${overrides.number}`,
    ...overrides,
  };
}

function projectId(connectorId: string, number: number): string {
  return `gh-project:${connectorId}:${number}`;
}

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedConnectorConfig(pool: Pool, connectorId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings,
        synced_lists, created_at, updated_at
      ) VALUES ($1, 'github-issues', 'Synthetic GitHub worker', true,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2)
      ON CONFLICT (id) DO NOTHING
    `,
    [connectorId, NOW],
  );
}

async function seedIdentityEpoch(
  pool: Pool,
  connectorId: string,
  revision: number,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (connector_instance_id)
      DO UPDATE SET mode_revision = EXCLUDED.mode_revision, updated_at = EXCLUDED.updated_at
    `,
    [connectorId, revision, NOW],
  );
}

async function seedTask(
  pool: Pool,
  row: {
    id: string;
    sourceId: string;
    connectorId: string;
    parentId?: string | null;
    depth?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        created_at, updated_at, last_synced_at, parent_id, depth,
        is_checklist_item, metadata
      ) VALUES ($1, $2, 'github-issues', $3, $1, 'todo', $4, $4, $4, $5, $6, false, $7::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      row.id,
      row.sourceId,
      row.connectorId,
      NOW,
      row.parentId ?? null,
      row.depth ?? 0,
      JSON.stringify(row.metadata ?? {}),
    ],
  );
}

/** Seeds the durable identity baseline the write fence and linked-source lookups read. */
async function seedFenceBaseline(pool: Pool, ids: WorkerIds): Promise<void> {
  await pool.query(
    `INSERT INTO github_identity_migrations (connector_instance_id, phase, updated_at)
     VALUES ($1, 'complete', $2)
     ON CONFLICT (connector_instance_id) DO NOTHING`,
    [ids.connectorId, NOW],
  );
  await pool.query(
    `INSERT INTO source_lists (id, connector_instance_id, source_id, name, type)
     VALUES ($1, $2, 'synthetic-owner/synthetic-repo', 'synthetic-owner/synthetic-repo', 'repo')
     ON CONFLICT (id) DO NOTHING`,
    [ids.sourceListId, ids.connectorId],
  );
  await pool.query(
    `
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        priority, sync_status, source_list_id, metadata, created_at, updated_at,
        last_synced_at
      ) VALUES ($1, $2, 'github-issues', $3, 'Fence me', 'todo', 'normal', 'pushing',
        $4, '{}'::jsonb, $5, $5, $6)
    `,
    [ids.taskId, ids.sourceId, ids.connectorId, ids.sourceListId, NOW, 'push-token-1'],
  );
  await pool.query(
    `
      INSERT INTO external_entities (id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at)
      VALUES
        ($1, 'github', 'github.com', 'repository', $2, $3, $3),
        ($4, 'github', 'github.com', 'issue', $5, $3, $3)
    `,
    [ids.repoEntityId, ids.repoStableId, NOW, ids.issueEntityId, ids.issueStableId],
  );
  await pool.query(
    `
      INSERT INTO external_entity_locators (
        id, external_entity_id, repository_entity_id, provider, host_key, owner,
        repository, owner_key, repository_key, issue_number, valid_from, last_seen_at,
        observation_source, locator_revision
      ) VALUES
        ($1, $2, NULL, 'github', 'github.com', 'synthetic-owner', 'synthetic-repo',
          'synthetic-owner', 'synthetic-repo', NULL, $3, $3, 'rest', 1),
        ($4, $5, $2, 'github', 'github.com', 'synthetic-owner', 'synthetic-repo',
          'synthetic-owner', 'synthetic-repo', 7, $3, $3, 'rest', 1)
    `,
    [`${ids.repoEntityId}:loc`, ids.repoEntityId, NOW, `${ids.issueEntityId}:loc`, ids.issueEntityId],
  );
  await pool.query(
    `
      INSERT INTO external_entity_bindings (
        id, external_entity_id, connector_instance_id, binding_type, local_id, state,
        verified_at, created_at, updated_at
      ) VALUES
        ($1, $2, $3, 'source_list', $4, 'active', $5, $5, $5),
        ($6, $7, $3, 'task', $8, 'active', $5, $5, $5)
    `,
    [
      `${ids.repoEntityId}:bind`,
      ids.repoEntityId,
      ids.connectorId,
      ids.sourceListId,
      NOW,
      `${ids.issueEntityId}:bind`,
      ids.issueEntityId,
      ids.taskId,
    ],
  );
  await pool.query(
    `
      INSERT INTO task_linked_sources (
        id, task_id, connector_type, connector_instance_id, source_id, title, linked_at
      ) VALUES ($1, $2, 'github-issues', $3, $4, 'Fence me', $5)
    `,
    [ids.linkedSourceId, ids.taskId, ids.connectorId, ids.sourceId, NOW],
  );
}

async function seedSnapshotRow(pool: Pool, record: DependencySnapshotRecord): Promise<void> {
  await pool.query(
    `
      INSERT INTO dependency_reconciliation_snapshots (
        id, connector_instance_id, status, phase, read_mode, cursor, total,
        batch_size, failure_count, imported_count, removed_count, started_at,
        updated_at, completed_at, collection_completed_at, collection_page_count,
        overflow_fetch_count, identity_mode, identity_mode_revision,
        identity_evidence_source, identity_evidence_eligible,
        identity_evidence_failure_reason, failed_at, next_attempt_at, failure_reason,
        last_resume_attempt_at, last_resume_outcome, last_resume_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
      )
    `,
    [
      record.id,
      record.connectorInstanceId,
      record.status,
      record.phase,
      record.readMode,
      record.cursor,
      record.total,
      record.batchSize,
      record.failureCount,
      record.importedCount,
      record.removedCount,
      record.startedAt,
      record.updatedAt,
      record.completedAt,
      record.collectionCompletedAt,
      record.collectionPageCount,
      record.overflowFetchCount,
      record.identityMode,
      record.identityModeRevision,
      record.identityEvidenceSource,
      record.identityEvidenceEligible,
      record.identityEvidenceFailureReason,
      record.failedAt,
      record.nextAttemptAt,
      record.failureReason,
      record.lastResumeAttemptAt,
      record.lastResumeOutcome,
      record.lastResumeReason,
    ],
  );
}

async function seedSuccessionState(pool: Pool, connectorId: string): Promise<void> {
  const sourceEntity = `${connectorId}:succ-src`;
  const successorEntity = `${connectorId}:succ-suc`;
  for (const [id, stable] of [
    [sourceEntity, 'src'],
    [successorEntity, 'suc'],
  ] as const) {
    await pool.query(
      `INSERT INTO external_entities (
         id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at
       ) VALUES ($1, 'github', 'github.com', 'issue', $2, $3, $3)`,
      [id, `${stable}-${randomUUID()}`, NOW],
    );
  }
  await pool.query(
    `INSERT INTO github_identity_task_transfer_reconciliations (
       id, connector_instance_id, source_task_id, successor_task_id,
       source_external_entity_id, successor_external_entity_id,
       expected_mode_revision, proof_kind, proof, proof_digest,
       observed_at, actor, reason, idempotency_key, created_at
     ) VALUES ($1, $2, 'source', 'successor', $3, $4, 1,
       'rest_historical_redirect', '{}'::jsonb, $5, $6, 'test',
       'worker-smoke', $7, $6)`,
    [randomUUID(), connectorId, sourceEntity, successorEntity, 'a'.repeat(64), NOW, randomUUID()],
  );
}

async function seedProvisionalSyncLog(
  pool: Pool,
  syncRunId: string,
  connectorId: string,
  syncedAt: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO sync_log (
        id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
        tasks_pushed, local_only_protected, alerts_added, errors, details,
        synced_at, job_id
      ) VALUES ($1, $2, false, 0, 0, 0, 0, 0, 0, '[]', '[]', $3, NULL)
    `,
    [syncRunId, connectorId, syncedAt],
  );
}

async function cleanupConnector(pool: Pool, connectorId: string): Promise<void> {
  const prefix = `${connectorId}:%`;
  await pool.query(
    `DELETE FROM notification_delivery_events WHERE notification_id IN (
       SELECT id FROM notifications WHERE connector_instance_id = $1)`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM notification_actions WHERE notification_id IN (
       SELECT id FROM notifications WHERE connector_instance_id = $1)`,
    [connectorId],
  );
  await pool.query('DELETE FROM notifications WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM notification_push_rules WHERE connector_instance_id = $1', [connectorId]);
  await pool.query(
    'DELETE FROM github_identity_task_transfer_reconciliations WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query('DELETE FROM github_identity_exception_events WHERE connector_instance_id = $1', [connectorId]);
  await pool.query(
    `DELETE FROM task_source_write_lease_targets WHERE lease_id IN (
       SELECT id FROM task_source_write_leases WHERE connector_instance_id = $1)`,
    [connectorId],
  );
  await pool.query('DELETE FROM task_source_write_leases WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM github_identity_write_cycles WHERE connector_instance_id = $1', [connectorId]);
  for (const table of [
    'dependency_reconciliation_candidates',
    'dependency_reconciliation_edges',
    'dependency_reconciliation_items',
  ]) {
    await pool.query(
      `DELETE FROM ${table} WHERE snapshot_id IN (
         SELECT id FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1)`,
      [connectorId],
    );
  }
  await pool.query('DELETE FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM task_dependencies WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM task_projects WHERE project_id LIKE $1', [`gh-project:${connectorId}:%`]);
  await pool.query(
    'DELETE FROM task_projects WHERE task_id IN (SELECT id FROM tasks WHERE connector_instance_id = $1)',
    [connectorId],
  );
  await pool.query('DELETE FROM hub_projects WHERE id LIKE $1', [`gh-project:${connectorId}:%`]);
  await pool.query('DELETE FROM external_entity_bindings WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM external_entity_locators WHERE external_entity_id LIKE $1', [prefix]);
  await pool.query('DELETE FROM external_entities WHERE id LIKE $1', [prefix]);
  await pool.query('DELETE FROM task_linked_sources WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM source_lists WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM github_identity_controls WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM github_identity_migrations WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM sync_log WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM connector_configs WHERE id = $1', [connectorId]);
}

const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL GitHub worker queue-execution smoke', () => {
  const connectorIds = new Set<string>();

  beforeAll(initialize, 120_000);

  afterEach(async () => {
    const pool = backend.context.pool;
    for (const connectorId of connectorIds) {
      await cleanupConnector(pool, connectorId);
    }
    connectorIds.clear();
  });

  it('runs the happy path end to end through every worker port', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);
    const execution = createPostgresConnectorExecutionRepositories(pool);
    const jobs = new PostgresSyncJobRepository(pool);
    const runs = new PostgresSyncRunRepository(backend.context.db);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedFenceBaseline(pool, ids);
    await seedTask(pool, { id: ids.parentTaskId, sourceId: 'synthetic-owner/synthetic-repo:1', connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.childTaskId, sourceId: 'synthetic-owner/synthetic-repo:2', connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.blockerTaskId, sourceId: ids.blockerSourceId, connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.blockedTaskId, sourceId: ids.blockedSourceId, connectorId: ids.connectorId });

    // github-issues is an enabled Layer 2 config the execution adapter recognizes.
    const enabled = await execution.support.listEnabledGitHubConfigs();
    expect(enabled.some((config) => config.id === ids.connectorId)).toBe(true);

    // Enqueue then claim exactly once — concurrent claims yield a single winner.
    const queued = await jobs.enqueue(ids.connectorId);
    const [a, b, c] = await Promise.all([
      jobs.claimNext(`worker-a-${ids.connectorId}`, 60_000),
      jobs.claimNext(`worker-b-${ids.connectorId}`, 60_000),
      jobs.claimNext(`worker-c-${ids.connectorId}`, 60_000),
    ]);
    const winners = [a, b, c].filter((claim) => claim?.id === queued.id);
    expect(winners).toHaveLength(1);
    const claimed = winners[0]!;

    // List identity through the execution adapter.
    await execution.lists.applyDiscovery({
      connectorId: ids.connectorId,
      upserts: [
        {
          id: ids.sourceListId,
          connectorInstanceId: ids.connectorId,
          sourceId: 'synthetic-owner/synthetic-repo',
          name: 'synthetic-owner/synthetic-repo',
          type: 'repo',
          taskCount: 1,
          lastSyncedAt: NOW,
          wellKnownListName: null,
          lastKnownRemoteName: 'synthetic-owner/synthetic-repo',
        },
      ],
      stale: [],
    });
    const snapshot = await execution.pulls.loadSnapshot(ids.connectorId, {
      includeLinkedSources: true,
    });
    expect(snapshot.linkedSources.some((linked) => linked.id === ids.linkedSourceId)).toBe(true);

    // Linked-source NodeID identity resolution.
    const persisted = await github.identity.persistLinkedSourceIdentityBatch({
      connectorInstanceId: ids.connectorId,
      writes: [
        {
          linkedSourceId: ids.linkedSourceId,
          hasEvidence: true,
          identityValid: true,
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: ids.issueStableId,
          ownerKey: 'synthetic-owner',
          repositoryKey: 'synthetic-repo',
          issueNumber: 7,
          canonicalSourceId: ids.sourceId,
          observedAt: NOW,
        },
      ],
    });
    expect(persisted).toEqual([{ linkedSourceId: ids.linkedSourceId, state: 'associated' }]);
    const lookup = await github.identity.lookupLinkedSourceIdentityBatch({
      connectorInstanceId: ids.connectorId,
      hostKey: 'github.com',
      rows: [
        {
          candidateKey: 'candidate-1',
          linkedSourceId: ids.linkedSourceId,
          stableId: ids.issueStableId,
          ownerKey: 'synthetic-owner',
          repositoryKey: 'synthetic-repo',
          issueNumber: 7,
        },
      ],
    });
    expect(lookup[0]).toMatchObject({ candidateKey: 'candidate-1', linkedTaskId: ids.taskId });

    // Task + dependency reconciliation: create → stage → complete → finalize.
    const generation = depSnapshot(ids.connectorId, {
      id: `${ids.connectorId}:gen`,
      status: 'running',
      phase: 'collecting',
      readMode: null,
      total: 0,
    });
    const created = await github.dependencies.createGeneration({
      connectorInstanceId: ids.connectorId,
      frozenModeRevision: MODE_REVISION,
      matchInsert: generation,
      mismatchInsert: depSnapshot(ids.connectorId, {
        id: generation.id,
        status: 'partial',
        phase: 'completed',
        identityEvidenceFailureReason: 'dependency_identity_context_changed',
      }),
      items: [],
      deletionCandidateIds: [],
    });
    expect(created).toBe(true);

    const staged = await github.dependencies.stageCollectionPage({
      fence: fenceOf(generation),
      expectedTotal: 0,
      readMode: 'graphql-bulk',
      identityEvidenceSource: 'graphql-node',
      newItems: [
        { position: 0, sourceId: ids.blockedSourceId, verified: true, identityEvidenceState: 'verified' },
      ],
      edges: [
        {
          blockerSourceId: ids.blockerSourceId,
          blockedSourceId: ids.blockedSourceId,
          blockerIdentityEvidence: null,
          blockerIdentityEvidenceState: 'verified',
        },
      ],
      newSourceIdCount: 1,
      overflowFetchCount: 0,
      updatedAt: NOW,
    });
    expect(staged).toBe(true);
    expect(await github.dependencies.countSnapshotEdges(generation.id)).toBe(1);

    const collected = await github.dependencies.completeCollection({
      fence: fenceOf(generation),
      readMode: 'graphql-bulk',
      identityEvidenceSource: 'graphql-node',
      completedAt: NOW,
      deriveEvidence: (incomplete) => ({
        identityEvidenceEligible: incomplete === 0,
        identityEvidenceFailureReason: incomplete === 0 ? null : 'dependency_remote_verification_incomplete',
      }),
    });
    expect(collected).toBe(true);

    const finalized = await github.dependencies.finalizeSnapshotGeneration({
      fence: fenceOf(generation),
      cursor: 0,
      total: 0,
      connectorInstanceId: ids.connectorId,
      completedAt: NOW,
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
      insertableEdges: [
        depInsert(ids.connectorId, {
          id: `${ids.connectorId}:dep`,
          taskId: ids.blockedTaskId,
          dependsOnTaskId: ids.blockerTaskId,
        }),
      ],
      removableDependencyIds: [],
      retainedSnapshotIds: [generation.id],
      insertChunkSize: 100,
      deleteChunkSize: 500,
    });
    expect(finalized).toEqual({ status: 'applied', imported: 1, removed: 0, prunedSnapshots: 0 });
    const depRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_dependencies WHERE connector_instance_id = $1',
      [ids.connectorId],
    );
    expect(depRows.rows[0]?.count).toBe('1');

    // Hierarchy reconciliation applies parent/depth/metadata.
    const hierarchyResult = await github.hierarchy.applyReconciliation({
      connectorInstanceId: ids.connectorId,
      observedEndpointTaskIds: [ids.parentTaskId, ids.childTaskId],
      reconcile: (context) => ({
        fenced: false,
        updates: updatesFrom(
          context,
          new Map([
            [
              ids.childTaskId,
              {
                parentId: ids.parentTaskId,
                depth: 1,
                githubParent: { sourceId: 'synthetic-owner/synthetic-repo:1', repository: 'synthetic-owner/synthetic-repo' },
              },
            ],
          ]),
        ),
      }),
    });
    expect(hierarchyResult).toEqual({ applied: true, updated: 1, fenced: false });
    const child = await pool.query<{ parentId: string | null; depth: number; metadata: unknown }>(
      'SELECT parent_id AS "parentId", depth, metadata FROM tasks WHERE id = $1',
      [ids.childTaskId],
    );
    expect(child.rows[0]?.parentId).toBe(ids.parentTaskId);
    expect(child.rows[0]?.depth).toBe(1);
    expect(child.rows[0]?.metadata).toMatchObject({
      githubParent: { sourceId: 'synthetic-owner/synthetic-repo:1', repository: 'synthetic-owner/synthetic-repo' },
    });

    // Project reconciliation upserts a hub project and links the routed tasks.
    await github.projects.reconcileSyncManagedProjects({
      connectorInstanceId: ids.connectorId,
      now: NOW,
      projects: [
        reconciliation(ids.connectorId, {
          number: 7,
          taskSourceIds: ['synthetic-owner/synthetic-repo:1', 'synthetic-owner/synthetic-repo:2'],
        }),
      ],
    });
    const hubProject = await pool.query<{ metadata: unknown }>(
      'SELECT metadata FROM hub_projects WHERE id = $1',
      [projectId(ids.connectorId, 7)],
    );
    expect(hubProject.rows[0]?.metadata).toMatchObject({ githubProjectNumber: 7, syncManaged: true });
    const linkedTasks = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_projects WHERE project_id = $1',
      [projectId(ids.connectorId, 7)],
    );
    expect(linkedTasks.rows[0]?.count).toBe('2');

    // Notification / action / delivery ingestion.
    await pool.query(
      `
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level,
          preview, max_per_hour, created_at, updated_at
        ) VALUES ($1, $2, 'generic_notice', true, 'fyi', 'title_only', NULL, $3, $3)
      `,
      [`${ids.connectorId}:push-rule`, ids.connectorId, NOW],
    );
    const [ingested] = await execution.notifications.ingest([
      {
        input: {
          id: `${ids.connectorId}:notification`,
          sourceId: `${ids.connectorId}:notice-1`,
          connectorType: 'github-issues',
          connectorInstanceId: ids.connectorId,
          title: 'Synthetic notification',
          body: null,
          level: 'fyi',
          category: 'general',
          templateKey: 'generic_notice',
          readState: 'unread',
          sourceState: 'active',
          sourceActivityAt: NOW,
          sourceActivityKey: 'one',
          reopenPolicy: 'handled',
          occurrenceKey: 'one',
          isActionable: true,
          primaryActionId: `${ids.connectorId}:action`,
          receivedAt: NOW,
          sortAt: NOW,
          relatedTaskId: null,
          relatedProjectId: null,
          relatedEntityType: null,
          relatedEntityId: null,
          navigationTarget: '/notifications',
          metadata: {},
          presentation: {},
        },
        actions: [
          {
            id: `${ids.connectorId}:action`,
            notificationId: `${ids.connectorId}:notification`,
            actionType: 'open_url',
            label: 'Open',
            variant: 'primary',
            isPrimary: true,
            sortOrder: 0,
            payload: { url: '/notifications' },
            opensExternal: false,
            requiresConfirmation: false,
            createdBy: 'connector',
          },
        ],
      },
    ]);
    expect(ingested.created).toBe(true);
    const notificationCounts = await pool.query<{ notifications: string; actions: string; deliveries: string }>(
      `
        SELECT
          (SELECT count(*) FROM notifications WHERE id = $1)::text AS notifications,
          (SELECT count(*) FROM notification_actions WHERE notification_id = $1)::text AS actions,
          (SELECT count(*) FROM notification_delivery_events WHERE notification_id = $1)::text AS deliveries
      `,
      [`${ids.connectorId}:notification`],
    );
    expect(notificationCounts.rows[0]?.notifications).toBe('1');
    expect(notificationCounts.rows[0]?.actions).toBe('1');
    expect(Number(notificationCounts.rows[0]?.deliveries)).toBeGreaterThanOrEqual(1);

    // Provisional sync_log publish + link + connector-lease release.
    const syncRunId = `${ids.connectorId}:success-log`;
    const syncedAt = new Date().toISOString();
    const result = {
      connectorId: ids.connectorId,
      success: true,
      tasksAdded: 0,
      tasksUpdated: 2,
      tasksRemoved: 0,
      notificationsAdded: 1,
      errors: [],
      syncedAt,
      syncRunId,
    };
    await runs.append({
      ...result,
      id: syncRunId,
      success: false,
      tasksPushed: 0,
      localOnlyProtected: 0,
      details: [],
      durationMs: 10,
      jobId: null,
      identityMode: null,
      identityModeRevision: null,
    });
    await jobs.finalizeSuccess(claimed, `worker-a-${ids.connectorId}`, result);
    await expect(jobs.get(claimed.id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { syncRunId },
    });
    const linked = await pool.query<{ success: boolean; jobId: string | null }>(
      'SELECT success, job_id AS "jobId" FROM sync_log WHERE id = $1',
      [syncRunId],
    );
    expect(linked.rows[0]).toEqual({ success: true, jobId: claimed.id });
    const lease = await pool.query('SELECT 1 FROM connector_operation_leases WHERE connector_id = $1', [ids.connectorId]);
    expect(lease.rowCount).toBe(0);
  });

  it('cancels a stale identity epoch without dispatching a remote write', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);
    const jobs = new PostgresSyncJobRepository(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedFenceBaseline(pool, ids);

    await jobs.enqueue(ids.connectorId);
    await jobs.claimNext(`worker-${ids.connectorId}`, 60_000);

    const cycleId = randomUUID();
    expect(
      await github.writeFence.beginWriteCycle({
        id: cycleId,
        connectorInstanceId: ids.connectorId,
        expectedModeRevision: MODE_REVISION,
        pendingCandidateCount: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true });

    // The identity epoch advances underneath the running write cycle.
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION + 1);

    const authorization = await github.writeFence.authorizeTaskWrite({
      connectorInstanceId: ids.connectorId,
      taskId: ids.taskId,
      operation: 'update',
      writeCycleId: cycleId,
      leaseId: randomUUID(),
      token: randomUUID(),
      expiresAt: EXPIRES,
      now: LATER,
      deriveWriteIdentity: deriveUpdateIdentity,
    });
    expect(authorization).toMatchObject({ ok: false, code: 'stale_write_cycle' });

    const freshCycle = await github.writeFence.beginWriteCycle({
      id: randomUUID(),
      connectorInstanceId: ids.connectorId,
      expectedModeRevision: MODE_REVISION,
      pendingCandidateCount: 1,
      now: LATER,
    });
    expect(freshCycle).toEqual({ ok: false, code: 'stale_write_cycle_mode' });

    const dispatched = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_source_write_leases
       WHERE connector_instance_id = $1 AND state = 'dispatched'`,
      [ids.connectorId],
    );
    expect(dispatched.rows[0]?.count).toBe('0');
  });

  it('rejects a finalize whose queue lease ownership was lost', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const jobs = new PostgresSyncJobRepository(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    const job = await jobs.enqueue(ids.connectorId);
    const claimed = await jobs.claimNext(`worker-owner-${ids.connectorId}`, 60_000);
    const syncedAt = new Date().toISOString();
    const syncRunId = `${ids.connectorId}:owner-log`;
    await seedProvisionalSyncLog(pool, syncRunId, ids.connectorId, syncedAt);

    await expect(
      jobs.finalizeSuccess(claimed!, `other-worker-${ids.connectorId}`, {
        connectorId: ids.connectorId,
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt,
        syncRunId,
      }),
    ).rejects.toThrow(/ownership was lost/);

    const log = await pool.query<{ success: boolean; jobId: string | null }>(
      'SELECT success, job_id AS "jobId" FROM sync_log WHERE id = $1',
      [syncRunId],
    );
    expect(log.rows[0]).toEqual({ success: false, jobId: null });
    await jobs.release(job.id, `worker-owner-${ids.connectorId}`, 'test cleanup');
  });

  it('does not commit a write lease when its write cycle is no longer running', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedFenceBaseline(pool, ids);

    const cycleId = randomUUID();
    const leaseId = randomUUID();
    const token = randomUUID();
    expect(
      await github.writeFence.beginWriteCycle({
        id: cycleId,
        connectorInstanceId: ids.connectorId,
        expectedModeRevision: MODE_REVISION,
        pendingCandidateCount: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true });
    const authorization = await github.writeFence.authorizeTaskWrite({
      connectorInstanceId: ids.connectorId,
      taskId: ids.taskId,
      operation: 'update',
      writeCycleId: cycleId,
      leaseId,
      token,
      expiresAt: EXPIRES,
      now: NOW,
      deriveWriteIdentity: deriveUpdateIdentity,
    });
    expect(authorization.ok).toBe(true);
    const authorizationRef = { leaseId, token, connectorInstanceId: ids.connectorId, taskId: ids.taskId };
    expect(await github.writeFence.recordCycleObservation({ leaseId, now: NOW })).toEqual({ ok: true });
    expect(await github.writeFence.confirmDispatch({ authorization: authorizationRef, now: LATER })).toBe(true);

    // The cycle is force-terminated before the write is finalized.
    await pool.query(
      `UPDATE github_identity_write_cycles SET state = 'completed' WHERE id = $1`,
      [cycleId],
    );

    const finalize = await github.writeFence.finalizeWrite({
      authorization: authorizationRef,
      outcome: 'succeeded',
      safeReason: null,
      resultDigest: 'result-1',
      now: LATER,
    });
    expect(finalize.status).not.toBe('committed');

    const lease = await pool.query<{ state: string }>(
      'SELECT state FROM task_source_write_leases WHERE id = $1',
      [leaseId],
    );
    expect(lease.rows[0]?.state).not.toBe('succeeded');
  });

  it('never deletes on an incomplete or fenced observation', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedTask(pool, { id: ids.parentTaskId, sourceId: 'synthetic-owner/synthetic-repo:1', connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.childTaskId, sourceId: 'synthetic-owner/synthetic-repo:2', connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.blockerTaskId, sourceId: ids.blockerSourceId, connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.blockedTaskId, sourceId: ids.blockedSourceId, connectorId: ids.connectorId });

    // Hierarchy: a fenced verdict changes nothing.
    const hierarchyResult = await github.hierarchy.applyReconciliation({
      connectorInstanceId: ids.connectorId,
      observedEndpointTaskIds: [ids.parentTaskId, ids.childTaskId],
      reconcile: () => ({ fenced: true }),
    });
    expect(hierarchyResult).toEqual({ applied: false, updated: 0, fenced: true });
    const child = await pool.query<{ parentId: string | null; depth: number }>(
      'SELECT parent_id AS "parentId", depth FROM tasks WHERE id = $1',
      [ids.childTaskId],
    );
    expect(child.rows[0]).toMatchObject({ parentId: null, depth: 0 });

    // Dependencies: an incomplete collection must never remove existing edges.
    await pool.query(
      `
        INSERT INTO task_dependencies (
          id, task_id, depends_on_task_id, type, connector_instance_id,
          sync_status, sync_action, sync_error, last_synced_at, created_at
        ) VALUES ($1, $2, $3, 'blocks', $4, 'synced', NULL, NULL, $5, $5)
      `,
      [`${ids.connectorId}:dep-survive`, ids.blockedTaskId, ids.blockerTaskId, ids.connectorId, NOW],
    );
    const collecting = depSnapshot(ids.connectorId, {
      id: `${ids.connectorId}:gen-fail`,
      status: 'running',
      phase: 'collecting',
      readMode: null,
      cursor: 0,
      total: 3,
    });
    await seedSnapshotRow(pool, collecting);
    expect(
      await github.dependencies.failCollection({
        fence: fenceOf(collecting),
        failedAt: NOW,
        failureReason: 'collection failed',
      }),
    ).toBe(true);
    expect(await github.dependencies.getDependencyById(`${ids.connectorId}:dep-survive`)).not.toBeNull();

    // Projects: a non-authoritative observation keeps existing links.
    await pool.query(
      `INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
       ON CONFLICT (task_id, project_id) DO NOTHING`,
      [ids.parentTaskId, projectId(ids.connectorId, 5)],
    );
    await github.projects.reconcileSyncManagedProjects({
      connectorInstanceId: ids.connectorId,
      now: NOW,
      projects: [reconciliation(ids.connectorId, { number: 5, authoritative: false, taskSourceIds: [] })],
    });
    const keptLink = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_projects WHERE project_id = $1',
      [projectId(ids.connectorId, 5)],
    );
    expect(keptLink.rows[0]?.count).toBe('1');
  });

  it('re-applies idempotently and reports the resume outcome', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedTask(pool, { id: ids.blockerTaskId, sourceId: ids.blockerSourceId, connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.blockedTaskId, sourceId: ids.blockedSourceId, connectorId: ids.connectorId });

    const insert = depInsert(ids.connectorId, {
      id: `${ids.connectorId}:dep`,
      taskId: ids.blockedTaskId,
      dependsOnTaskId: ids.blockerTaskId,
    });
    const first = await github.dependencies.applyTargetedReconciliation({
      connectorInstanceId: ids.connectorId,
      expectedModeRevision: MODE_REVISION,
      syncedAt: NOW,
      syncedUpdateIds: [],
      inserts: [insert],
      deletionIds: [],
    });
    expect(first).toEqual({ status: 'applied', imported: 1, removed: 0 });
    const second = await github.dependencies.applyTargetedReconciliation({
      connectorInstanceId: ids.connectorId,
      expectedModeRevision: MODE_REVISION,
      syncedAt: NOW,
      syncedUpdateIds: [],
      inserts: [insert],
      deletionIds: [],
    });
    expect(second).toEqual({ status: 'applied', imported: 0, removed: 0 });
    const depCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_dependencies WHERE connector_instance_id = $1',
      [ids.connectorId],
    );
    expect(depCount.rows[0]?.count).toBe('1');

    // Re-observing the same edge across pages must not duplicate it.
    const collecting = depSnapshot(ids.connectorId, {
      id: `${ids.connectorId}:gen-collect`,
      status: 'running',
      phase: 'collecting',
      readMode: null,
      total: 0,
    });
    await seedSnapshotRow(pool, collecting);
    const edge = {
      blockerSourceId: ids.blockerSourceId,
      blockedSourceId: ids.blockedSourceId,
      blockerIdentityEvidence: null,
      blockerIdentityEvidenceState: 'verified' as const,
    };
    expect(
      await github.dependencies.stageCollectionPage({
        fence: fenceOf(collecting),
        expectedTotal: 0,
        readMode: 'graphql-bulk',
        identityEvidenceSource: 'graphql-node',
        newItems: [{ position: 0, sourceId: ids.blockedSourceId, verified: true, identityEvidenceState: 'verified' }],
        edges: [edge],
        newSourceIdCount: 1,
        overflowFetchCount: 0,
        updatedAt: NOW,
      }),
    ).toBe(true);
    expect(await github.dependencies.countSnapshotEdges(collecting.id)).toBe(1);
    expect(
      await github.dependencies.stageCollectionPage({
        fence: fenceOf(collecting),
        expectedTotal: 1,
        readMode: 'graphql-bulk',
        identityEvidenceSource: 'graphql-node',
        newItems: [],
        edges: [edge],
        newSourceIdCount: 0,
        overflowFetchCount: 0,
        updatedAt: NOW,
      }),
    ).toBe(true);
    expect(await github.dependencies.countSnapshotEdges(collecting.id)).toBe(1);

    await pool.query(
      `UPDATE dependency_reconciliation_snapshots
       SET status = 'completed', phase = 'completed', completed_at = $2, updated_at = $2
       WHERE id = $1`,
      [collecting.id, LATER],
    );

    // Resume read path reports the recorded outcome.
    const resumable = depSnapshot(ids.connectorId, {
      id: `${ids.connectorId}:gen-resume`,
      status: 'running',
      phase: 'reconciling',
      cursor: 2,
      total: 5,
    });
    await seedSnapshotRow(pool, resumable);
    const resumables = await github.dependencies.getResumableReconciliations();
    expect(resumables.some((row) => row.generationId === resumable.id)).toBe(true);
    await github.dependencies.recordResumeOutcome({
      generationId: resumable.id,
      outcome: 'deferred',
      reason: 'resume smoke',
      attemptedAt: LATER,
    });
    expect((await github.dependencies.getSnapshotById(resumable.id))?.lastResumeOutcome).toBe('deferred');
  });

  it('cleans up only from a complete authoritative observation and preserves blocked project numbers', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedTask(pool, { id: ids.parentTaskId, sourceId: 'synthetic-owner/synthetic-repo:1', connectorId: ids.connectorId });
    await seedTask(pool, { id: ids.childTaskId, sourceId: 'synthetic-owner/synthetic-repo:2', connectorId: ids.connectorId });

    // A complete authoritative observation prunes a stale association.
    await pool.query(
      `INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
       ON CONFLICT (task_id, project_id) DO NOTHING`,
      [ids.parentTaskId, projectId(ids.connectorId, 6)],
    );
    await github.projects.reconcileSyncManagedProjects({
      connectorInstanceId: ids.connectorId,
      now: NOW,
      projects: [reconciliation(ids.connectorId, { number: 6, authoritative: true, taskSourceIds: [] })],
    });
    const pruned = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_projects WHERE project_id = $1',
      [projectId(ids.connectorId, 6)],
    );
    expect(pruned.rows[0]?.count).toBe('0');

    // A withheld (blocked) project number is never rewritten.
    await pool.query(
      `INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
       ON CONFLICT (task_id, project_id) DO NOTHING`,
      [ids.parentTaskId, projectId(ids.connectorId, 5)],
    );
    await github.projects.reconcileSyncManagedProjects({
      connectorInstanceId: ids.connectorId,
      now: NOW,
      projects: [
        reconciliation(ids.connectorId, {
          number: 7,
          authoritative: true,
          taskSourceIds: ['synthetic-owner/synthetic-repo:2'],
        }),
      ],
    });
    const blocked = await pool.query<{ taskId: string }>(
      'SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1',
      [projectId(ids.connectorId, 5)],
    );
    expect(blocked.rows.map((row) => row.taskId)).toEqual([ids.parentTaskId]);
    const open = await pool.query<{ taskId: string }>(
      'SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1',
      [projectId(ids.connectorId, 7)],
    );
    expect(open.rows.map((row) => row.taskId)).toEqual([ids.childTaskId]);
  });

  it('ignores historical succession state that cannot be revalidated', async () => {
    const ids = makeIds();
    connectorIds.add(ids.connectorId);
    const pool = backend.context.pool;
    const github = createPostgresGitHubWorkerRepositories(pool);

    await seedConnectorConfig(pool, ids.connectorId);
    await seedIdentityEpoch(pool, ids.connectorId, MODE_REVISION);
    await seedSuccessionState(pool, ids.connectorId);

    await expect(
      github.hierarchy.provenSupersededTaskIds(ids.connectorId, ['source', 'successor']),
    ).resolves.toEqual([]);

    await expect(
      github.hierarchy.applyReconciliation({
        connectorInstanceId: ids.connectorId,
        observedEndpointTaskIds: ['source', 'successor'],
        reconcile: () => ({ fenced: false, updates: [] }),
      }),
    ).resolves.toEqual({ applied: true, updated: 0, fenced: false });
  });
});

describe.skipIf(Boolean(connectionString))('PostgreSQL GitHub worker queue-execution smoke', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await backend.shutdown();
    initialized = false;
  }
});
