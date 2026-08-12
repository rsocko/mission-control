import { createHash } from 'node:crypto';
import db, { sqlite } from '@/db';
import { getGitHubIdentityModeSnapshot } from './mode-control';
import { hasCompleteGitHubSubIssueAttestation } from './sub-issue-attestation';
import {
  digestGitHubTaskPopulationMembers,
} from '@/lib/sync/github-native-task';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STAGE_TWO_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const IMPLEMENTED_SURFACES = [
  'source_list',
  'task',
  'project_association',
  'linked_source',
  'dependency',
  'sub_issue',
  'deletion',
  'write_route',
] as const;
const UNCOVERED_GATES: readonly string[] = [];

export interface GitHubIdentityComparisonStatusOptions {
  limit?: number;
  includeEvidence?: boolean;
  now?: string;
}

export interface GitHubStablePrimaryEligibility {
  eligible: boolean;
  blockers: readonly string[];
}

interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  settings: string;
  syncedLists: string;
}

interface ComparisonRunRow {
  id: string;
  jobId: string | null;
  identityMode: string;
  identityModeRevision: number;
  syncKind: string;
  state: string;
  pageCount: number;
  queryCount: number;
  linkedSourceRecordCount: number;
  outcomeCounts: string;
  lookupLatencyP50Ms: number | null;
  lookupLatencyP95Ms: number | null;
  lookupLatencyP99Ms: number | null;
  evidenceEligible: number;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

interface DependencyIdentityCoverageRow {
  generationId: string;
  readMode: string | null;
  identityMode: string;
  identityModeRevision: number;
  identityEvidenceSource: string;
  identityEvidenceEligible: number;
  identityComparisonRunId: string | null;
  identityEvidenceFailureReason: string | null;
  collectionPageCount: number;
  overflowFetchCount: number;
  completedAt: string | null;
  comparisonRunState: string | null;
  comparisonRunQueryCount: number | null;
  comparisonRunPageCount: number | null;
}

interface SubIssueIdentityCoverageRow {
  runId: string;
  identityMode: string;
  identityModeRevision: number;
  state: string;
  evidenceEligible: number;
  completedAt: string | null;
  generationComplete: number;
  expectedChildCount: number;
  expectedParentCount: number;
  endpointCount: number;
  childEndpointCount: number;
  parentEndpointCount: number;
  blockingRecordCount: number;
  populationCount: number;
  populationDigest: string | null;
  observedChildCount: number;
  observedChildDigest: string | null;
}

export function getGitHubIdentityComparisonStatus(
  connectorInstanceId: string,
  options: GitHubIdentityComparisonStatusOptions = {},
): Record<string, unknown> {
  const limit = validateLimit(options.limit ?? DEFAULT_LIMIT);
  const now = options.now ?? new Date().toISOString();
  const evidenceFreshAfter = new Date(
    new Date(now).getTime() - STAGE_TWO_EVIDENCE_MAX_AGE_MS,
  ).toISOString();
  const connector = sqlite.prepare(`
    SELECT
      id,
      type,
      name,
      settings,
      synced_lists AS syncedLists
    FROM connector_configs
    WHERE id = ?
  `).get(connectorInstanceId) as ConnectorRow | undefined;
  if (!connector || connector.type !== 'github-issues') {
    throw new Error('GitHub connector instance was not found');
  }
  const mode = getGitHubIdentityModeSnapshot(connectorInstanceId, now);

  const runs = sqlite.prepare(`
    SELECT
      id,
      job_id AS jobId,
      identity_mode AS identityMode,
      identity_mode_revision AS identityModeRevision,
      sync_kind AS syncKind,
      state,
      page_count AS pageCount,
      query_count AS queryCount,
      (
        SELECT COUNT(*)
        FROM github_identity_comparison_records AS linked_record
        WHERE linked_record.run_id = github_identity_comparison_runs.id
          AND linked_record.surface = 'linked_source'
      ) AS linkedSourceRecordCount,
      outcome_counts AS outcomeCounts,
      lookup_latency_p50_ms AS lookupLatencyP50Ms,
      lookup_latency_p95_ms AS lookupLatencyP95Ms,
      lookup_latency_p99_ms AS lookupLatencyP99Ms,
      evidence_eligible AS evidenceEligible,
      started_at AS startedAt,
      completed_at AS completedAt,
      error_code AS errorCode
    FROM github_identity_comparison_runs
    WHERE connector_instance_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(connectorInstanceId, limit) as ComparisonRunRow[];
  const selectedRepositories = configuredRepositories(connector);
  const repositoryCoverage = selectedRepositories.map((repository) => {
    const row = sqlite.prepare(`
      SELECT
        source_lists.id AS localId,
        bindings.state AS bindingState
      FROM source_lists
      LEFT JOIN external_entity_bindings AS bindings
        ON bindings.connector_instance_id = source_lists.connector_instance_id
        AND bindings.binding_type = 'source_list'
        AND bindings.local_id = source_lists.id
        AND bindings.state != 'retired'
      LEFT JOIN external_entities AS entities
        ON entities.id = bindings.external_entity_id
        AND entities.provider = 'github'
        AND entities.entity_type = 'repository'
      LEFT JOIN external_entity_locators AS locator
        ON locator.external_entity_id = entities.id
        AND locator.valid_to IS NULL
      WHERE source_lists.connector_instance_id = ?
        AND lower(source_lists.source_id) = lower(?)
        AND entities.id IS NOT NULL
        AND bindings.state IN ('shadow', 'active')
        AND bindings.verified_at IS NOT NULL
        AND lower(locator.owner || '/' || locator.repository) = lower(?)
      LIMIT 1
    `).get(connectorInstanceId, repository, repository) as {
      localId: string;
      bindingState: string;
    } | undefined;
    return {
      repository,
      bound: row !== undefined && row.bindingState !== 'collision',
      localSourceListId: row?.localId ?? null,
      bindingState: row?.bindingState ?? null,
    };
  });
  const activeCollisions = count(`
    SELECT COUNT(*) AS value
    FROM github_identity_collisions
    WHERE connector_instance_id = ? AND state = 'open'
  `, connectorInstanceId);
  const activeDependencySnapshots = count(`
    SELECT COUNT(*) AS value
    FROM dependency_reconciliation_snapshots
    WHERE connector_instance_id = ? AND status IN ('running', 'failed')
  `, connectorInstanceId);
  const activeSyncJobs = count(`
    SELECT COUNT(*) AS value
    FROM sync_jobs
    WHERE connector_id = ? AND status IN ('queued', 'running')
  `, connectorInstanceId);
  const activeConnectorOperations = count(`
    SELECT COUNT(*) AS value
    FROM connector_operation_leases
    WHERE connector_id = ? AND lease_expires_at > ?
  `, connectorInstanceId, now);
  const deletionCandidates = count(`
    SELECT COUNT(*) AS value
    FROM sync_deletion_candidates
    WHERE connector_id = ?
  `, connectorInstanceId);
  const successfulFullEvidenceRuns = (sqlite.prepare(`
    SELECT
      run.id,
      run.sync_kind AS syncKind,
      run.sub_issue_generation_complete AS subIssueGenerationComplete,
      run.sub_issue_expected_child_count AS subIssueExpectedChildCount,
      run.sub_issue_expected_parent_count AS subIssueExpectedParentCount,
      run.sub_issue_population_count AS subIssuePopulationCount,
      run.sub_issue_population_digest AS subIssuePopulationDigest,
      run.sub_issue_observed_child_count AS subIssueObservedChildCount,
      run.sub_issue_observed_child_digest AS subIssueObservedChildDigest
    FROM github_identity_comparison_runs AS run
    WHERE run.connector_instance_id = ?
      AND run.sync_kind = 'full'
      AND run.identity_mode = 'comparison'
      AND run.identity_mode_revision = ?
      AND run.state = 'succeeded'
      AND run.evidence_eligible = 1
      AND run.completed_at >= ?
      AND run.query_count <= MAX(
        2,
        run.page_count * 2 + 2 + (
          SELECT (COUNT(*) + 499) / 500
          FROM github_identity_comparison_records AS linked_record
          WHERE linked_record.run_id = run.id
            AND linked_record.surface = 'linked_source'
        )
      )
  `).all(
    connectorInstanceId,
    mode.modeRevision,
    evidenceFreshAfter,
  ) as Array<{
    id: string;
    syncKind: string;
    subIssueGenerationComplete: number;
    subIssueExpectedChildCount: number;
    subIssueExpectedParentCount: number;
    subIssuePopulationCount: number;
    subIssuePopulationDigest: string | null;
    subIssueObservedChildCount: number;
    subIssueObservedChildDigest: string | null;
  }>).filter((run) => hasCompleteGitHubSubIssueAttestation(db, {
    ...run,
    subIssueGenerationComplete: Boolean(run.subIssueGenerationComplete),
  })).length;
  const comparisonWriteCycles = count(`
    SELECT COUNT(*) AS value
    FROM github_identity_write_cycles
    WHERE connector_instance_id = ?
      AND effective_mode = 'comparison'
      AND mode_revision = ?
      AND completed_at >= ?
      AND state = 'completed'
      AND pending_candidate_count > 0
      AND observed_route_count = pending_candidate_count
      AND legacy_applied_count = pending_candidate_count
      AND blocked_count = 0
      AND failed_count = 0
      AND unknown_count = 0
      AND reconciliation_state = 'unresolved'
  `, connectorInstanceId, mode.modeRevision, evidenceFreshAfter);
  const activeWriteLeases = count(`
    SELECT COUNT(*) AS value
    FROM task_source_write_leases
    WHERE connector_instance_id = ?
      AND state IN ('claimed', 'authorized', 'dispatched')
  `, connectorInstanceId);
  const unknownWriteLeases = count(`
    SELECT COUNT(*) AS value
    FROM task_source_write_leases
    WHERE connector_instance_id = ? AND state = 'unknown'
  `, connectorInstanceId);
  const writeCycleReconciliation = getWriteCycleReconciliationStatus(
    connectorInstanceId,
    limit,
  );
  const incompleteWriteCycles = writeCycleReconciliation.unresolvedCount;
  const comparisonCycleReconciliation = getComparisonCycleReconciliationStatus(
    connectorInstanceId,
    limit,
  );
  const pendingRecoverySnapshots = count(`
    SELECT COUNT(*) AS value
    FROM sync_deletion_snapshots
    WHERE connector_id = ? AND recovery_state IN ('pending', 'restoring')
  `, connectorInstanceId);
  const quarantinedRecoverySnapshots = count(`
    SELECT COUNT(*) AS value
    FROM sync_deletion_snapshots
    WHERE connector_id = ? AND recovery_state = 'quarantined'
  `, connectorInstanceId);
  const acceptedExceptions = latestAcceptedExceptions(connectorInstanceId, limit);
  const acceptedExceptionCount = countLatestAcceptedExceptions(connectorInstanceId);
  const latestCurrentRun = runs.find((run) => (
    run.identityMode === 'comparison'
    && run.identityModeRevision === mode.modeRevision
    && run.syncKind === 'full'
  ));
  const latestBlockingEvidence = latestCurrentRun
    ? blockingEvidenceCounts(latestCurrentRun.id)
    : {
        disagreements: 0,
        collisions: 0,
        pathReuse: 0,
        partialFetches: 0,
      };
  const unexplainedInaccessible = latestCurrentRun
    ? countUnexplainedInaccessible(latestCurrentRun.id)
    : 0;
  const dependencyIdentityCoverage = getDependencyIdentityCoverage(
    connectorInstanceId,
    mode.effectiveMode,
    mode.modeRevision,
    evidenceFreshAfter,
  );
  const subIssueIdentityCoverage = getSubIssueIdentityCoverage(
    connectorInstanceId,
    mode.effectiveMode,
    mode.modeRevision,
    evidenceFreshAfter,
  );
  const stageTwoBlockers: string[] = [];
  if (mode.effectiveMode !== 'comparison') stageTwoBlockers.push('connector_not_in_comparison_mode');
  if (mode.stablePrimaryEnabled) stageTwoBlockers.push('stable_primary_must_remain_disabled');
  if (activeSyncJobs > 0) stageTwoBlockers.push('sync_jobs_not_idle');
  if (activeConnectorOperations > 0) {
    stageTwoBlockers.push('connector_operation_not_idle');
  }
  if (successfulFullEvidenceRuns < 2) stageTwoBlockers.push('two_successful_full_runs_required');
  if (comparisonWriteCycles < 1) stageTwoBlockers.push('pending_write_cycle_not_observed');
  if (incompleteWriteCycles > 0) stageTwoBlockers.push('pending_write_cycle_incomplete');
  if (comparisonCycleReconciliation.comparisonUnresolvedCount > 0) {
    stageTwoBlockers.push('comparison_cycle_unresolved');
  }
  if (comparisonCycleReconciliation.subIssueUnresolvedCount > 0) {
    stageTwoBlockers.push('sub_issue_cycle_unresolved');
  }
  if (activeWriteLeases > 0) stageTwoBlockers.push('active_write_lease');
  if (unknownWriteLeases > 0) stageTwoBlockers.push('unknown_write_outcome');
  if (repositoryCoverage.some((repository) => !repository.bound)) {
    stageTwoBlockers.push('selected_repository_binding_incomplete');
  }
  if (activeCollisions > 0) stageTwoBlockers.push('active_collision');
  if (activeDependencySnapshots > 0) stageTwoBlockers.push('dependency_snapshot_not_idle');
  if (deletionCandidates > 0) stageTwoBlockers.push('deletion_candidates_not_idle');
  if (pendingRecoverySnapshots > 0) stageTwoBlockers.push('deletion_recovery_not_idle');
  if (quarantinedRecoverySnapshots > 0) {
    stageTwoBlockers.push('deletion_recovery_quarantined');
  }
  if (!latestCurrentRun) {
    stageTwoBlockers.push('current_revision_comparison_evidence_required');
  } else {
    if (latestCurrentRun.state !== 'succeeded') {
      stageTwoBlockers.push('latest_full_comparison_run_incomplete');
    }
    if (!Boolean(latestCurrentRun.evidenceEligible)) {
      stageTwoBlockers.push('latest_full_comparison_run_ineligible');
    }
    if (
      !latestCurrentRun.completedAt
      || latestCurrentRun.completedAt < evidenceFreshAfter
    ) {
      stageTwoBlockers.push('comparison_evidence_stale');
    }
  }
  if (latestCurrentRun && !isRunWithinQueryBound(latestCurrentRun)) {
    stageTwoBlockers.push('comparison_query_bound_exceeded');
  }
  if (latestBlockingEvidence.disagreements > 0) {
    stageTwoBlockers.push('unexplained_stable_legacy_disagreement');
  }
  if (latestBlockingEvidence.collisions > 0) stageTwoBlockers.push('comparison_collision');
  if (latestBlockingEvidence.pathReuse > 0) stageTwoBlockers.push('repository_path_reuse');
  if (latestBlockingEvidence.partialFetches > 0) stageTwoBlockers.push('partial_fetch_evidence');
  if (unexplainedInaccessible > 0) stageTwoBlockers.push('unexplained_inaccessible_evidence');
  if (!dependencyIdentityCoverage.covered) {
    stageTwoBlockers.push('dependency_identity_evidence_required');
  }
  if (!subIssueIdentityCoverage.covered) {
    stageTwoBlockers.push('sub_issue_identity_evidence_required');
  }
  stageTwoBlockers.push(...UNCOVERED_GATES.map((gate) => `uncovered:${gate}`));

  const status: Record<string, unknown> = {
    connector: {
      id: connector.id,
      name: connector.name,
    },
    mode,
    coverage: {
      implementedSurfaces: IMPLEMENTED_SURFACES,
      uncoveredGates: UNCOVERED_GATES,
      dependencyIdentity: dependencyIdentityCoverage,
      subIssueIdentity: subIssueIdentityCoverage,
    },
    selectedRepositories: repositoryCoverage,
    operationalState: {
      activeSyncJobs,
      activeConnectorOperations,
      activeCollisions,
      activeDependencySnapshots,
      deletionCandidates,
      activeWriteLeases,
      unknownWriteLeases,
      incompleteWriteCycles,
      writeCycleReconciliation,
      comparisonCycleReconciliation,
      pendingRecoverySnapshots,
      quarantinedRecoverySnapshots,
      acceptedTerminalInaccessibleExceptions: acceptedExceptionCount,
      unexplainedInaccessible,
      latestBlockingEvidence,
    },
    terminalExceptionProofRequirements: {
      stage1: ['inaccessible_backfill_disposition', 'cancelled_task'],
      postBackfill: [
        'bound_backfill_disposition',
        'verified_non_retired_task_binding',
        'succeeded_full_comparison_run',
        'inaccessible_deletion_record_for_same_task',
        'explicit_authoritative_deletion_confirmation',
        'cancelled_task',
      ],
      soak: 'A fresh successful full comparison run after acceptance is required.',
    },
    soak: {
      successfulFullEvidenceRuns,
      requiredSuccessfulFullEvidenceRuns: 2,
      comparisonWriteCycles,
      requiredComparisonWriteCycles: 1,
    },
    stageTwo: {
      eligible: stageTwoBlockers.length === 0,
      blockers: stageTwoBlockers,
    },
    cutover: {
      preflightReady: mode.effectiveMode === 'comparison' && stageTwoBlockers.length === 0,
      stableActive: mode.effectiveMode === 'stable' && mode.stablePrimaryEnabled,
      rollback: {
        ready: mode.effectiveMode === 'stable' && mode.stablePrimaryEnabled,
        blockers: mode.effectiveMode === 'stable' && mode.stablePrimaryEnabled
          ? []
          : ['connector_not_stable_primary'],
      },
      postCutoverVerification: getPostCutoverVerification(
        connectorInstanceId,
        mode.effectiveMode,
        mode.modeRevision,
      ),
      legacyRetirement: {
        blocked: true,
        reason: 'sustained_stable_soak_and_rollback_evidence_required',
      },
    },
    modeAudit: recentModeAudit(connectorInstanceId, limit),
    runs: runs.map(formatRun),
    acceptedExceptions,
  };
  if (options.includeEvidence && runs[0]) {
    status.evidence = comparisonEvidence(runs[0].id, limit);
  }
  return status;
}

export function getGitHubStablePrimaryEligibility(
  connectorInstanceId: string,
  now = new Date().toISOString(),
): GitHubStablePrimaryEligibility {
  const status = getGitHubIdentityComparisonStatus(connectorInstanceId, { now }) as {
    stageTwo: { eligible: boolean; blockers: string[] };
  };
  return Object.freeze({
    eligible: status.stageTwo.eligible,
    blockers: Object.freeze([...status.stageTwo.blockers]),
  });
}

function getPostCutoverVerification(
  connectorInstanceId: string,
  effectiveMode: string,
  modeRevision: number,
): Record<string, unknown> {
  const incrementalRuns = count(`
    SELECT COUNT(*) AS value
    FROM github_identity_comparison_runs
    WHERE connector_instance_id = ?
      AND identity_mode = 'stable'
      AND identity_mode_revision = ?
      AND sync_kind = 'incremental'
      AND state = 'succeeded'
  `, connectorInstanceId, modeRevision);
  const fullRuns = count(`
    SELECT COUNT(*) AS value
    FROM github_identity_comparison_runs
    WHERE connector_instance_id = ?
      AND identity_mode = 'stable'
      AND identity_mode_revision = ?
      AND sync_kind = 'full'
      AND state = 'succeeded'
      AND evidence_eligible = 1
  `, connectorInstanceId, modeRevision);
  const blockingRecords = count(`
    SELECT COUNT(*) AS value
    FROM github_identity_comparison_records AS record
    INNER JOIN github_identity_comparison_runs AS run ON run.id = record.run_id
    WHERE run.connector_instance_id = ?
      AND run.identity_mode = 'stable'
      AND run.identity_mode_revision = ?
      AND run.state = 'succeeded'
      AND run.evidence_eligible = 1
      AND record.outcome NOT IN ('agreement', 'locator_change')
      AND NOT (
        record.surface = 'deletion'
        AND record.outcome = 'inaccessible'
        AND record.reason = 'access_denied'
        AND EXISTS (
          SELECT 1
          FROM github_identity_exception_events AS exception
          WHERE exception.connector_instance_id = run.connector_instance_id
            AND exception.binding_type = 'task'
            AND exception.local_id = record.local_task_id
            AND exception.category = 'terminal_inaccessible'
            AND exception.id = (
              SELECT MAX(latest.id)
              FROM github_identity_exception_events AS latest
              WHERE latest.connector_instance_id = exception.connector_instance_id
                AND latest.binding_type = exception.binding_type
                AND latest.local_id = exception.local_id
                AND latest.category = exception.category
            )
            AND exception.action = 'accept'
        )
      )
  `, connectorInstanceId, modeRevision);
  const blockers: string[] = [];
  if (effectiveMode !== 'stable') blockers.push('connector_not_stable_primary');
  if (incrementalRuns < 1) blockers.push('stable_incremental_run_required');
  if (fullRuns < 2) blockers.push('two_stable_full_runs_required');
  if (blockingRecords > 0) blockers.push('stable_blocking_identity_evidence');
  return {
    complete: blockers.length === 0,
    incrementalRuns,
    requiredIncrementalRuns: 1,
    fullRuns,
    requiredFullRuns: 2,
    blockingRecords,
    blockers,
  };
}

function recentModeAudit(connectorInstanceId: string, limit: number): unknown[] {
  const rows = sqlite.prepare(`
    SELECT
      id,
      old_phase AS oldPhase,
      new_phase AS newPhase,
      old_mode_revision AS oldModeRevision,
      new_mode_revision AS newModeRevision,
      actor,
      reason,
      idempotency_key AS idempotencyKey,
      gate_result_code AS gateResultCode,
      created_at AS createdAt
    FROM github_identity_mode_events
    WHERE connector_instance_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(connectorInstanceId, limit) as Array<Record<string, unknown>>;
  return rows.map(({ reason, idempotencyKey, actor, ...row }) => ({
    ...row,
    actor: boundedAuditActor(actor),
    reasonDigest: auditDigest(reason),
    idempotencyKeyDigest: auditDigest(idempotencyKey),
  }));
}

function boundedAuditActor(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[^a-z0-9@._:-]/gi, '_').slice(0, 80)
    : 'unknown';
}

function auditDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex');
}

function getWriteCycleReconciliationStatus(
  connectorInstanceId: string,
  limit: number,
): {
  unresolvedCount: number;
  preDispatchRetryableCount: number;
  postDispatchRetryableCount: number;
  resolvedCount: number;
  supersededCount: number;
  quarantinedCount: number;
  cycles: Array<Record<string, unknown>>;
} {
  const counts = sqlite.prepare(`
    SELECT
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'quarantined'
          OR state = 'running'
          OR (state = 'interrupted' AND reconciliation_state NOT IN (
            'pre_dispatch_retryable', 'resolved', 'superseded'
          ))
          OR (
            state = 'completed'
            AND reconciliation_state NOT IN (
              'pre_dispatch_retryable', 'resolved', 'superseded'
            )
            AND (
              pending_candidate_count > observed_route_count
              OR blocked_count > 0
              OR failed_count > 0
              OR unknown_count > 0
            )
          )
        THEN 1 ELSE 0 END), 0) AS unresolvedCount,
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'pre_dispatch_retryable' THEN 1 ELSE 0 END
      ), 0) AS preDispatchRetryableCount,
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'post_dispatch_retryable' THEN 1 ELSE 0 END
      ), 0) AS postDispatchRetryableCount,
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'resolved' THEN 1 ELSE 0 END
      ), 0) AS resolvedCount,
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'superseded' THEN 1 ELSE 0 END
      ), 0) AS supersededCount,
      COALESCE(SUM(CASE
        WHEN reconciliation_state = 'quarantined' THEN 1 ELSE 0 END
      ), 0) AS quarantinedCount
    FROM github_identity_write_cycles
    WHERE connector_instance_id = ?
  `).get(connectorInstanceId) as {
    unresolvedCount: number;
    preDispatchRetryableCount: number;
    postDispatchRetryableCount: number;
    resolvedCount: number;
    supersededCount: number;
    quarantinedCount: number;
  };
  const rows = sqlite.prepare(`
    SELECT cycle.id,
      cycle.state,
      cycle.mode_revision AS modeRevision,
      cycle.pending_candidate_count AS pendingCandidateCount,
      cycle.observed_route_count AS observedRouteCount,
      cycle.legacy_applied_count AS appliedCount,
      cycle.blocked_count AS blockedCount,
      cycle.failed_count AS failedCount,
      cycle.unknown_count AS unknownCount,
      cycle.reconciliation_state AS reconciliationState,
      cycle.reconciliation_reason AS reconciliationReason,
      cycle.reconciliation_code AS reconciliationCode,
      cycle.reconciled_at AS reconciledAt,
      cycle.reconciled_by AS reconciledBy,
      cycle.reconciliation_idempotency_key AS reconciliationIdempotencyKey,
      cycle.started_at AS startedAt,
      cycle.completed_at AS completedAt,
      COALESCE(SUM(CASE
        WHEN lease.state IN ('claimed', 'authorized') THEN 1 ELSE 0 END
      ), 0) AS activeLeaseCount,
      COALESCE(SUM(CASE
        WHEN lease.state IN ('dispatched', 'unknown') OR lease.dispatched_at IS NOT NULL
        THEN 1 ELSE 0 END
      ), 0) AS dispatchEvidenceCount
    FROM github_identity_write_cycles AS cycle
    LEFT JOIN task_source_write_leases AS lease
      ON lease.connector_instance_id = cycle.connector_instance_id
      AND (
        lease.write_cycle_id = cycle.id
        OR (
          cycle.comparison_run_id IS NOT NULL
          AND lease.write_cycle_id IS NULL
          AND lease.comparison_run_id = cycle.comparison_run_id
        )
      )
    WHERE cycle.connector_instance_id = ?
      AND (
        cycle.state != 'completed'
        OR cycle.pending_candidate_count > cycle.observed_route_count
        OR cycle.blocked_count > 0
        OR cycle.failed_count > 0
        OR cycle.unknown_count > 0
        OR cycle.reconciliation_state != 'unresolved'
      )
    GROUP BY cycle.id
    ORDER BY cycle.started_at DESC, cycle.id DESC
    LIMIT ?
  `).all(connectorInstanceId, limit) as Array<{
    id: string;
    state: string;
    modeRevision: number;
    pendingCandidateCount: number;
    observedRouteCount: number;
    appliedCount: number;
    blockedCount: number;
    failedCount: number;
    unknownCount: number;
    reconciliationState: string;
    reconciliationReason: string | null;
    reconciliationCode: string | null;
    reconciledAt: string | null;
    reconciledBy: string | null;
    reconciliationIdempotencyKey: string | null;
    startedAt: string;
    completedAt: string | null;
    activeLeaseCount: number;
    dispatchEvidenceCount: number;
  }>;
  return {
    unresolvedCount: Number(counts.unresolvedCount),
    preDispatchRetryableCount: Number(counts.preDispatchRetryableCount),
    postDispatchRetryableCount: Number(counts.postDispatchRetryableCount),
    resolvedCount: Number(counts.resolvedCount),
    supersededCount: Number(counts.supersededCount),
    quarantinedCount: Number(counts.quarantinedCount),
    cycles: rows.map((row) => ({
      id: row.id,
      state: row.state,
      modeRevision: row.modeRevision,
      pendingCandidateCount: Number(row.pendingCandidateCount),
      observedRouteCount: Number(row.observedRouteCount),
      appliedCount: Number(row.appliedCount),
      blockedCount: Number(row.blockedCount),
      failedCount: Number(row.failedCount),
      unknownCount: Number(row.unknownCount),
      reconciliationState: row.reconciliationState,
      reconciliationReasonCode: row.reconciliationCode,
      reconciledAt: row.reconciledAt,
      reconciledBy: row.reconciledBy ? boundedAuditActor(row.reconciledBy) : null,
      reconciliationReasonDigest: row.reconciliationReason
        ? auditDigest(row.reconciliationReason)
        : null,
      reconciliationIdempotencyKeyDigest: row.reconciliationIdempotencyKey
        ? auditDigest(row.reconciliationIdempotencyKey)
        : null,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      activeLeaseCount: Number(row.activeLeaseCount),
      dispatchEvidenceCount: Number(row.dispatchEvidenceCount),
    })),
  };
}

function getComparisonCycleReconciliationStatus(
  connectorInstanceId: string,
  limit: number,
): {
  unresolvedCount: number;
  comparisonUnresolvedCount: number;
  subIssueUnresolvedCount: number;
  cycles: Array<Record<string, unknown>>;
} {
  const counts = sqlite.prepare(`
    SELECT
      COUNT(*) AS unresolvedCount,
      COALESCE(SUM(CASE
        WHEN interruption_surface = 'comparison' THEN 1 ELSE 0 END
      ), 0) AS comparisonUnresolvedCount,
      COALESCE(SUM(CASE
        WHEN interruption_surface = 'sub_issue' THEN 1 ELSE 0 END
      ), 0) AS subIssueUnresolvedCount
    FROM github_identity_comparison_runs
    WHERE connector_instance_id = ?
      AND interruption_state = 'unresolved'
  `).get(connectorInstanceId) as {
    unresolvedCount: number;
    comparisonUnresolvedCount: number;
    subIssueUnresolvedCount: number;
  };
  const rows = sqlite.prepare(`
    SELECT
      id,
      identity_mode AS identityMode,
      identity_mode_revision AS modeRevision,
      sync_kind AS syncKind,
      state,
      interruption_surface AS interruptionSurface,
      interruption_reason AS interruptionReason,
      owner_id AS ownerId,
      predecessor_run_id AS predecessorRunId,
      interrupted_at AS interruptedAt,
      owner_lease_expires_at AS ownerLeaseExpiresAt
    FROM github_identity_comparison_runs
    WHERE connector_instance_id = ?
      AND interruption_state = 'unresolved'
    ORDER BY interrupted_at DESC, id DESC
    LIMIT ?
  `).all(connectorInstanceId, limit) as Array<{
    id: string;
    identityMode: string;
    modeRevision: number;
    syncKind: string;
    state: string;
    interruptionSurface: string;
    interruptionReason: string;
    ownerId: string | null;
    predecessorRunId: string | null;
    interruptedAt: string;
    ownerLeaseExpiresAt: string | null;
  }>;
  return {
    unresolvedCount: Number(counts.unresolvedCount),
    comparisonUnresolvedCount: Number(counts.comparisonUnresolvedCount),
    subIssueUnresolvedCount: Number(counts.subIssueUnresolvedCount),
    cycles: rows.map((row) => ({
      id: row.id,
      identityMode: row.identityMode,
      modeRevision: row.modeRevision,
      syncKind: row.syncKind,
      state: row.state,
      interruptionSurface: row.interruptionSurface,
      interruptionReason: row.interruptionReason,
      ownerDigest: row.ownerId ? auditDigest(row.ownerId) : null,
      predecessorRunId: row.predecessorRunId,
      interruptedAt: row.interruptedAt,
      ownerLeaseExpiresAt: row.ownerLeaseExpiresAt,
    })),
  };
}

function getSubIssueIdentityCoverage(
  connectorInstanceId: string,
  effectiveMode: string,
  modeRevision: number,
  evidenceFreshAfter: string,
): Record<string, unknown> & { covered: boolean } {
  const evidence = sqlite.prepare(`
    SELECT
      run.id AS runId,
      run.identity_mode AS identityMode,
      run.identity_mode_revision AS identityModeRevision,
      run.state,
      run.evidence_eligible AS evidenceEligible,
      run.completed_at AS completedAt,
      run.sub_issue_generation_complete AS generationComplete,
      run.sub_issue_expected_child_count AS expectedChildCount,
      run.sub_issue_expected_parent_count AS expectedParentCount,
      run.sub_issue_population_count AS populationCount,
      run.sub_issue_population_digest AS populationDigest,
      run.sub_issue_observed_child_count AS observedChildCount,
      run.sub_issue_observed_child_digest AS observedChildDigest,
      COUNT(record.id) AS endpointCount,
      COALESCE(SUM(
        CASE WHEN record.candidate_key LIKE 'sub_issue:%:child' THEN 1 ELSE 0 END
      ), 0) AS childEndpointCount,
      COALESCE(SUM(
        CASE WHEN record.candidate_key LIKE 'sub_issue:%:parent' THEN 1 ELSE 0 END
      ), 0) AS parentEndpointCount,
      COALESCE(SUM(
        CASE
          WHEN record.id IS NOT NULL
            AND record.outcome NOT IN ('agreement', 'locator_change')
          THEN 1
          ELSE 0
        END
      ), 0) AS blockingRecordCount
    FROM github_identity_comparison_runs AS run
    LEFT JOIN github_identity_comparison_records AS record
      ON record.run_id = run.id
      AND record.surface = 'sub_issue'
    WHERE run.connector_instance_id = ?
      AND run.sync_kind = 'full'
    GROUP BY run.id
    ORDER BY run.started_at DESC, run.id DESC
    LIMIT 1
  `).get(connectorInstanceId) as SubIssueIdentityCoverageRow | undefined;
  if (!evidence) {
    return {
      covered: false,
      run: null,
      endpointCount: 0,
      generationComplete: false,
      expectedChildCount: 0,
      expectedParentCount: 0,
      childEndpointCount: 0,
      parentEndpointCount: 0,
      blockingRecordCount: 0,
      reasons: ['completed_sub_issue_full_run_required'],
    };
  }

  const endpointCount = Number(evidence.endpointCount);
  const expectedChildCount = Number(evidence.expectedChildCount);
  const expectedParentCount = Number(evidence.expectedParentCount);
  const childEndpointCount = Number(evidence.childEndpointCount);
  const parentEndpointCount = Number(evidence.parentEndpointCount);
  const blockingRecordCount = Number(evidence.blockingRecordCount);
  const populationCount = Number(evidence.populationCount);
  const observedChildCount = Number(evidence.observedChildCount);
  const childRecords = sqlite.prepare(`
    SELECT local_task_id AS localTaskId
    FROM github_identity_comparison_records
    WHERE run_id = ?
      AND surface = 'sub_issue'
      AND candidate_key LIKE 'sub_issue:%:child'
    ORDER BY candidate_key, local_task_id
  `).all(evidence.runId) as Array<{
    localTaskId: string | null;
  }>;
  const populationMembers = sqlite.prepare(`
    SELECT
      local_task_id AS localTaskId,
      member_digest AS memberDigest,
      observed
    FROM github_identity_sub_issue_population_members
    WHERE run_id = ?
    ORDER BY member_digest
  `).all(evidence.runId) as Array<{
    localTaskId: string;
    memberDigest: string;
    observed: number;
  }>;
  const populationMemberByTaskId = new Map(
    populationMembers.map((member) => [member.localTaskId, member]),
  );
  const storedPopulationDigest = digestGitHubTaskPopulationMembers(
    populationMembers.map((member) => member.memberDigest),
  );
  const storedObservedDigest = digestGitHubTaskPopulationMembers(
    populationMembers
      .filter((member) => Boolean(member.observed))
      .map((member) => member.memberDigest),
  );
  const childPopulationMembers = childRecords.flatMap((record) => {
    const member = record.localTaskId
      ? populationMemberByTaskId.get(record.localTaskId)
      : undefined;
    return member ? [member.memberDigest] : [];
  });
  const recordPopulationDigest = digestGitHubTaskPopulationMembers(childPopulationMembers);
  const reasons: string[] = [];
  if (effectiveMode !== 'comparison') reasons.push('connector_not_in_comparison_mode');
  if (
    evidence.identityMode !== effectiveMode
    || evidence.identityModeRevision !== modeRevision
  ) {
    reasons.push('sub_issue_identity_context_stale');
  }
  if (evidence.state !== 'succeeded') {
    reasons.push('sub_issue_comparison_run_incomplete');
  }
  if (!Boolean(evidence.evidenceEligible)) {
    reasons.push('sub_issue_comparison_run_ineligible');
  }
  if (!Boolean(evidence.generationComplete)) {
    reasons.push('sub_issue_generation_incomplete');
  }
  if (!evidence.completedAt || evidence.completedAt < evidenceFreshAfter) {
    reasons.push('sub_issue_identity_evidence_stale');
  }
  if (
    endpointCount !== childEndpointCount + parentEndpointCount
    || childEndpointCount !== expectedChildCount
    || parentEndpointCount !== expectedParentCount
  ) {
    reasons.push('sub_issue_endpoint_comparison_incomplete');
  }
  if (
    !evidence.populationDigest
    || !evidence.observedChildDigest
    || populationCount !== expectedChildCount
    || observedChildCount !== populationCount
    || evidence.populationDigest !== evidence.observedChildDigest
    || populationMembers.length !== populationCount
    || storedPopulationDigest !== evidence.populationDigest
    || populationMembers.filter((member) => Boolean(member.observed)).length
      !== observedChildCount
    || storedObservedDigest !== evidence.observedChildDigest
    || childPopulationMembers.length !== populationCount
    || recordPopulationDigest !== evidence.populationDigest
  ) {
    reasons.push('sub_issue_population_attestation_incomplete');
  }
  if (blockingRecordCount > 0) {
    reasons.push('sub_issue_identity_blocking_evidence');
  }
  return {
    covered: reasons.length === 0,
    run: {
      id: evidence.runId,
      identityMode: evidence.identityMode,
      identityModeRevision: evidence.identityModeRevision,
      state: evidence.state,
      evidenceEligible: Boolean(evidence.evidenceEligible),
      completedAt: evidence.completedAt,
    },
    endpointCount,
    generationComplete: Boolean(evidence.generationComplete),
    expectedChildCount,
    expectedParentCount,
    populationCount,
    populationDigest: evidence.populationDigest,
    observedChildCount,
    observedChildDigest: evidence.observedChildDigest,
    recordPopulationDigest,
    childEndpointCount,
    parentEndpointCount,
    blockingRecordCount,
    reasons,
  };
}

function getDependencyIdentityCoverage(
  connectorInstanceId: string,
  effectiveMode: string,
  modeRevision: number,
  evidenceFreshAfter: string,
): Record<string, unknown> & { covered: boolean } {
  const generation = sqlite.prepare(`
    SELECT
      snapshot.id AS generationId,
      snapshot.read_mode AS readMode,
      snapshot.identity_mode AS identityMode,
      snapshot.identity_mode_revision AS identityModeRevision,
      snapshot.identity_evidence_source AS identityEvidenceSource,
      snapshot.identity_evidence_eligible AS identityEvidenceEligible,
      snapshot.identity_comparison_run_id AS identityComparisonRunId,
      snapshot.identity_evidence_failure_reason AS identityEvidenceFailureReason,
      snapshot.collection_page_count AS collectionPageCount,
      snapshot.overflow_fetch_count AS overflowFetchCount,
      snapshot.completed_at AS completedAt,
      run.state AS comparisonRunState,
      run.query_count AS comparisonRunQueryCount,
      run.page_count AS comparisonRunPageCount
    FROM dependency_reconciliation_snapshots AS snapshot
    LEFT JOIN github_identity_comparison_runs AS run
      ON run.id = snapshot.identity_comparison_run_id
    WHERE snapshot.connector_instance_id = ?
      AND snapshot.status IN ('completed', 'partial')
    ORDER BY snapshot.started_at DESC, snapshot.id DESC
    LIMIT 1
  `).get(connectorInstanceId) as DependencyIdentityCoverageRow | undefined;
  if (!generation) {
    return {
      covered: false,
      generation: null,
      endpointCount: 0,
      comparisonRecordCount: 0,
      missingOrPartialEndpointCount: 0,
      blockingRecordCount: 0,
      reasons: ['completed_dependency_generation_required'],
    };
  }

  const endpointCounts = sqlite.prepare(`
    WITH endpoint(source_id, evidence_state) AS (
      SELECT source_id, identity_evidence_state
      FROM dependency_reconciliation_items
      WHERE snapshot_id = ?
      UNION ALL
      SELECT blocker_source_id, blocker_identity_evidence_state
      FROM dependency_reconciliation_edges
      WHERE snapshot_id = ?
    ),
    endpoint_state AS (
      SELECT
        source_id,
        MAX(CASE WHEN evidence_state != 'verified' THEN 1 ELSE 0 END) AS incomplete
      FROM endpoint
      GROUP BY source_id
    )
    SELECT
      COUNT(*) AS endpointCount,
      COALESCE(SUM(incomplete), 0) AS missingOrPartialEndpointCount
    FROM endpoint_state
  `).get(generation.generationId, generation.generationId) as {
    endpointCount: number;
    missingOrPartialEndpointCount: number;
  };
  const recordCounts = generation.identityComparisonRunId
    ? sqlite.prepare(`
        SELECT
          COUNT(*) AS comparisonRecordCount,
          COALESCE(SUM(
            CASE WHEN outcome NOT IN ('agreement', 'locator_change') THEN 1 ELSE 0 END
          ), 0) AS blockingRecordCount
        FROM github_identity_comparison_records
        WHERE run_id = ? AND surface = 'dependency'
      `).get(generation.identityComparisonRunId) as {
        comparisonRecordCount: number;
        blockingRecordCount: number;
      }
    : { comparisonRecordCount: 0, blockingRecordCount: 0 };
  const endpointCount = Number(endpointCounts.endpointCount);
  const missingOrPartialEndpointCount = Number(
    endpointCounts.missingOrPartialEndpointCount,
  );
  const comparisonRecordCount = Number(recordCounts.comparisonRecordCount);
  const blockingRecordCount = Number(recordCounts.blockingRecordCount);
  const reasons: string[] = [];
  if (effectiveMode !== 'comparison') reasons.push('connector_not_in_comparison_mode');
  if (
    generation.identityMode !== effectiveMode
    || generation.identityModeRevision !== modeRevision
  ) {
    reasons.push('dependency_identity_context_stale');
  }
  if (generation.readMode !== 'graphql-bulk') {
    reasons.push('dependency_graphql_evidence_required');
  }
  if (generation.identityEvidenceSource !== 'graphql-node') {
    reasons.push('dependency_node_evidence_unavailable');
  }
  if (!Boolean(generation.identityEvidenceEligible)) {
    reasons.push(
      generation.identityEvidenceFailureReason ?? 'dependency_identity_evidence_ineligible',
    );
  }
  if (generation.comparisonRunState !== 'succeeded') {
    reasons.push('dependency_comparison_run_incomplete');
  }
  if (!generation.completedAt || generation.completedAt < evidenceFreshAfter) {
    reasons.push('dependency_identity_evidence_stale');
  }
  if (missingOrPartialEndpointCount > 0) {
    reasons.push('dependency_endpoint_evidence_incomplete');
  }
  if (endpointCount === 0) reasons.push('dependency_endpoint_evidence_empty');
  if (comparisonRecordCount !== endpointCount) {
    reasons.push('dependency_endpoint_comparison_incomplete');
  }
  if (blockingRecordCount > 0) reasons.push('dependency_identity_blocking_evidence');

  return {
    covered: reasons.length === 0,
    generation: {
      id: generation.generationId,
      readMode: generation.readMode,
      identityMode: generation.identityMode,
      identityModeRevision: generation.identityModeRevision,
      identityEvidenceSource: generation.identityEvidenceSource,
      identityEvidenceEligible: Boolean(generation.identityEvidenceEligible),
      identityComparisonRunId: generation.identityComparisonRunId,
      identityEvidenceFailureReason: generation.identityEvidenceFailureReason,
      collectionPageCount: generation.collectionPageCount,
      overflowFetchCount: generation.overflowFetchCount,
      completedAt: generation.completedAt,
    },
    endpointCount,
    comparisonRecordCount,
    missingOrPartialEndpointCount,
    blockingRecordCount,
    lookup: {
      queryCount: generation.comparisonRunQueryCount,
      pageCount: generation.comparisonRunPageCount,
      maxBatchSize: 500,
    },
    reasons: [...new Set(reasons)],
  };
}

function formatRun(run: ComparisonRunRow): Record<string, unknown> {
  const queryBound = isRunWithinQueryBound(run);
  const reasons: string[] = [];
  if (run.state !== 'succeeded') reasons.push(`run_${run.state}`);
  if (run.syncKind !== 'full') reasons.push('incremental_run');
  if (!queryBound) reasons.push('comparison_query_bound_exceeded');
  if (!Boolean(run.evidenceEligible)) reasons.push('blocking_evidence');
  return {
    id: run.id,
    jobId: run.jobId,
    identityMode: run.identityMode,
    identityModeRevision: run.identityModeRevision,
    syncKind: run.syncKind,
    state: run.state,
    pageCount: run.pageCount,
    queryCount: run.queryCount,
    queryBudget: comparisonQueryBudget(run),
    queriesPerPage: run.pageCount === 0 ? null : run.queryCount / run.pageCount,
    queryBound,
    outcomeCounts: parseJsonRecord(run.outcomeCounts),
    lookupLatencyMs: {
      p50: run.lookupLatencyP50Ms,
      p95: run.lookupLatencyP95Ms,
      p99: run.lookupLatencyP99Ms,
    },
    evidenceEligible: Boolean(run.evidenceEligible) && queryBound,
    evidenceIneligibilityReasons: reasons,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    errorCode: run.errorCode,
  };
}

function isRunWithinQueryBound(
  run: Pick<ComparisonRunRow, 'pageCount' | 'queryCount' | 'linkedSourceRecordCount'>,
): boolean {
  return run.queryCount <= comparisonQueryBudget(run);
}

function comparisonQueryBudget(
  run: Pick<ComparisonRunRow, 'pageCount' | 'linkedSourceRecordCount'>,
): number {
  const linkedSourceBatches = Math.ceil(run.linkedSourceRecordCount / 500);
  return Math.max(2, run.pageCount * 2 + 2 + linkedSourceBatches);
}

function comparisonEvidence(runId: string, limit: number): unknown[] {
  const rows = sqlite.prepare(`
    SELECT
      record.surface,
      record.candidate_key AS candidateKey,
      record.local_task_id AS localTaskId,
      record.local_source_list_id AS localSourceListId,
      record.legacy_selected_local_id AS legacySelectedLocalId,
      record.stable_selected_local_id AS stableSelectedLocalId,
      record.legacy_action AS legacyAction,
      record.stable_action AS stableAction,
      record.outcome,
      record.reason,
      record.stable_id_digest AS stableIdDigest,
      record.locator_revision AS locatorRevision,
      record.legacy_lookup_ms AS legacyLookupMs,
      record.stable_lookup_ms AS stableLookupMs,
      record.created_at AS createdAt,
      exception.action AS exceptionAction,
      exception.proof_type AS exceptionProofType
    FROM github_identity_comparison_records AS record
    INNER JOIN github_identity_comparison_runs AS run ON run.id = record.run_id
    LEFT JOIN github_identity_exception_events AS exception
      ON exception.connector_instance_id = run.connector_instance_id
      AND exception.binding_type = 'task'
      AND exception.local_id = record.local_task_id
      AND exception.category = 'terminal_inaccessible'
      AND exception.id = (
        SELECT MAX(latest.id)
        FROM github_identity_exception_events AS latest
        WHERE latest.connector_instance_id = exception.connector_instance_id
          AND latest.binding_type = exception.binding_type
          AND latest.local_id = exception.local_id
          AND latest.category = exception.category
      )
    WHERE record.run_id = ?
    ORDER BY record.created_at, record.surface, record.candidate_key
    LIMIT ?
  `).all(runId, limit) as Array<Record<string, unknown>>;
  return rows.map(({ exceptionAction, exceptionProofType, ...record }) => ({
    ...record,
    terminalExceptionStatus: record.outcome !== 'inaccessible'
      ? 'not_applicable'
      : exceptionAction === 'accept'
        ? 'accepted'
        : 'unexplained',
    terminalExceptionProofType: record.outcome === 'inaccessible' && exceptionAction === 'accept'
      ? exceptionProofType ?? 'stage1_inaccessible'
      : null,
  }));
}

function latestAcceptedExceptions(connectorInstanceId: string, limit: number): unknown[] {
  const rows = sqlite.prepare(`
    SELECT
      event.binding_type AS bindingType,
      event.local_id AS localId,
      event.category,
      event.actor,
      event.reason,
      COALESCE(event.proof_type, 'stage1_inaccessible') AS proofType,
      event.comparison_run_id AS comparisonRunId,
      event.created_at AS acceptedAt
    FROM github_identity_exception_events AS event
    WHERE event.connector_instance_id = ?
      AND event.id = (
        SELECT MAX(latest.id)
        FROM github_identity_exception_events AS latest
        WHERE latest.connector_instance_id = event.connector_instance_id
          AND latest.binding_type = event.binding_type
          AND latest.local_id = event.local_id
          AND latest.category = event.category
      )
      AND event.action = 'accept'
    ORDER BY event.id DESC
    LIMIT ?
  `).all(connectorInstanceId, limit) as Array<Record<string, unknown>>;
  return rows.map(({ actor, reason, ...row }) => ({
    ...row,
    actor: boundedAuditActor(actor),
    reasonDigest: auditDigest(reason),
  }));
}

function countLatestAcceptedExceptions(connectorInstanceId: string): number {
  return count(`
    SELECT COUNT(*) AS value
    FROM github_identity_exception_events AS event
    WHERE event.connector_instance_id = ?
      AND event.id = (
        SELECT MAX(latest.id)
        FROM github_identity_exception_events AS latest
        WHERE latest.connector_instance_id = event.connector_instance_id
          AND latest.binding_type = event.binding_type
          AND latest.local_id = event.local_id
          AND latest.category = event.category
      )
      AND event.action = 'accept'
  `, connectorInstanceId);
}

function blockingEvidenceCounts(runId: string): {
  disagreements: number;
  collisions: number;
  pathReuse: number;
  partialFetches: number;
} {
  return sqlite.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN outcome = 'stable_legacy_disagree' THEN 1 ELSE 0 END), 0)
        AS disagreements,
      COALESCE(SUM(CASE WHEN outcome = 'collision' THEN 1 ELSE 0 END), 0)
        AS collisions,
      COALESCE(SUM(CASE WHEN outcome = 'path_reuse' THEN 1 ELSE 0 END), 0)
        AS pathReuse,
      COALESCE(SUM(CASE WHEN outcome = 'partial_fetch' THEN 1 ELSE 0 END), 0)
        AS partialFetches
    FROM github_identity_comparison_records
    WHERE run_id = ?
  `).get(runId) as {
    disagreements: number;
    collisions: number;
    pathReuse: number;
    partialFetches: number;
  };
}

function countUnexplainedInaccessible(runId: string): number {
  return count(`
    SELECT COUNT(*) AS value
    FROM github_identity_comparison_records AS record
    INNER JOIN github_identity_comparison_runs AS run ON run.id = record.run_id
    WHERE record.run_id = ?
      AND record.outcome = 'inaccessible'
      AND (
        record.surface <> 'deletion'
        OR record.reason <> 'access_denied'
        OR NOT EXISTS (
          SELECT 1
          FROM github_identity_exception_events AS event
          WHERE event.connector_instance_id = run.connector_instance_id
            AND event.binding_type = 'task'
            AND event.local_id = record.local_task_id
            AND event.category = 'terminal_inaccessible'
            AND event.id = (
              SELECT MAX(latest.id)
              FROM github_identity_exception_events AS latest
              WHERE latest.connector_instance_id = event.connector_instance_id
                AND latest.binding_type = event.binding_type
                AND latest.local_id = event.local_id
                AND latest.category = event.category
            )
            AND event.action = 'accept'
        )
      )
  `, runId);
}

function configuredRepositories(connector: ConnectorRow): string[] {
  const settings = parseJsonRecord(connector.settings);
  const configured = Array.isArray(settings.repos)
    ? settings.repos.filter((value): value is string => typeof value === 'string')
    : [];
  if (configured.length > 0) return [...new Set(configured)].sort();
  const syncedLists = parseJsonArray(connector.syncedLists)
    .filter((value): value is string => typeof value === 'string');
  return [...new Set(syncedLists)].sort();
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function count(statement: string, ...values: Array<string | number>): number {
  return (sqlite.prepare(statement).get(...values) as { value: number }).value;
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Evidence limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}
