import { createHash, randomUUID } from 'node:crypto';
import { runTransaction, sqlite } from '@/db';
import type {
  GitHubIdentityComparisonAction,
  GitHubIdentityComparisonRunState,
  GitHubIdentityComparisonSurface,
  ExternalBindingType,
} from '@/db/schema';
import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityResolutionCandidate,
  GitHubIdentityResolutionDecision,
  GitHubIdentityStableResolutionAlternative,
} from './comparison-types';
import {
  appendGitHubIdentityComparisonRecords,
  completeGitHubIdentityComparisonRun,
  completeGitHubIdentityComparisonRunInTransaction,
  heartbeatGitHubIdentityComparisonRun,
  startGitHubIdentityComparisonRunInTransaction,
} from './comparison-service';
import {
  resolveGitHubStableIdentityBatch,
} from './comparison-query';
import type { ExternalIdentityEvidence } from './types';
import type { ExternalIdentityTransaction } from './service';
import { resolveGitHubIdentityBatch } from './resolver';
import { getGitHubIdentityModeSnapshot } from './mode-control';
import {
  resolveGitHubLinkedSourceIdentityBatch,
  type GitHubLinkedSourceIdentityCandidate,
} from './linked-source-identity';
import { hasAcceptedGitHubTerminalInaccessibleException } from './compatibility-exceptions';

export interface GitHubComparisonObservationCandidate {
  candidateKey: string;
  legacySelectedLocalIds: readonly string[];
  legacyAction: GitHubIdentityComparisonAction;
  applicableStableLocalIds?: ReadonlySet<string>;
  evidence?: ExternalIdentityEvidence;
  localTaskId?: string;
  localSourceListId?: string;
  unmatchedStableAction?: GitHubIdentityComparisonAction;
}

export interface GitHubComparisonResolvedCandidate
  extends Omit<GitHubComparisonObservationCandidate, 'evidence' | 'unmatchedStableAction'> {
  stable: GitHubIdentityStableResolutionAlternative;
}

export interface GitHubIdentityComparisonRuntimeOptions {
  connectorInstanceId: string;
  jobId?: string;
  modeSnapshot: GitHubIdentityModeSnapshot;
  syncKind: 'full' | 'incremental';
}

export class GitHubIdentityComparisonRuntime {
  readonly runId: string;
  readonly modeSnapshot: GitHubIdentityModeSnapshot;
  private readonly connectorInstanceId: string;
  private readonly jobId?: string;
  private readonly ownerToken: string;
  private readonly syncKind: 'full' | 'incremental';
  private readonly lookupLatencies: number[] = [];
  private readonly observedStableLocalIds = new Set<string>();
  private readonly ineligibilityReasons = new Set<string>();
  private pageCount = 0;
  private queryCount = 0;
  private completed = false;
  private subIssueGeneration = {
    complete: false,
    expectedChildCount: 0,
    expectedParentCount: 0,
    populationCount: 0,
    populationDigest: null as string | null,
    observedChildCount: 0,
    observedChildDigest: null as string | null,
  };

  constructor(options: GitHubIdentityComparisonRuntimeOptions) {
    if (options.modeSnapshot.connectorInstanceId !== options.connectorInstanceId) {
      throw new Error('GitHub identity mode snapshot belongs to another connector');
    }
    if (
      options.modeSnapshot.effectiveMode !== 'comparison'
      && options.modeSnapshot.effectiveMode !== 'stable'
    ) {
      throw new Error('GitHub identity runtime requires comparison or stable mode');
    }
    if (
      options.modeSnapshot.effectiveMode === 'comparison'
      && options.modeSnapshot.stablePrimaryEnabled
    ) {
      throw new Error('GitHub comparison runtime requires stable-primary to be disabled');
    }
    if (
      options.modeSnapshot.effectiveMode === 'stable'
      && !options.modeSnapshot.stablePrimaryEnabled
    ) {
      throw new Error('GitHub stable runtime requires stable-primary to be enabled');
    }
    this.connectorInstanceId = options.connectorInstanceId;
    this.jobId = options.jobId;
    this.ownerToken = randomUUID();
    this.modeSnapshot = options.modeSnapshot;
    this.syncKind = options.syncKind;
    this.runId = runTransaction((tx) => {
      return startGitHubIdentityComparisonRunInTransaction(tx, {
        connectorInstanceId: options.connectorInstanceId,
        jobId: options.jobId,
        identityMode: options.modeSnapshot.effectiveMode,
        identityModeRevision: options.modeSnapshot.modeRevision,
        syncKind: options.syncKind,
        ownerId: options.jobId ? `job:${options.jobId}` : `runtime:${randomUUID()}`,
        ownerToken: this.ownerToken,
      }).id;
    });
  }

  markNetworkPage(): void {
    this.assertRunning();
    heartbeatGitHubIdentityComparisonRun(this.runId, this.ownerToken);
    this.pageCount++;
  }

  assertCurrentMode(): void {
    this.assertRunning();
    const current = getGitHubIdentityModeSnapshot(this.connectorInstanceId);
    if (
      current.effectiveMode !== this.modeSnapshot.effectiveMode
      || current.modeRevision !== this.modeSnapshot.modeRevision
      || current.stablePrimaryEnabled !== this.modeSnapshot.stablePrimaryEnabled
    ) {
      throw new Error('GitHub identity runtime mode revision is stale');
    }
  }

  assertDecisionsCurrent(
    decisions: Iterable<GitHubIdentityResolutionDecision>,
  ): void {
    this.assertCurrentMode();
    if (this.modeSnapshot.effectiveMode !== 'stable') return;
    for (const decision of decisions) {
      if (
        decision.appliedSource !== 'stable'
        || !decision.selectedLocalId
        || !decision.externalEntityId
        || !decision.bindingRevision
        || decision.locatorRevision === null
      ) continue;
      const bindingType = decision.surface === 'source_list' ? 'source_list' : 'task';
      const current = sqlite.prepare(`
        SELECT 1
        FROM external_entity_bindings AS binding
        INNER JOIN external_entity_locators AS locator
          ON locator.external_entity_id = binding.external_entity_id
          AND locator.valid_to IS NULL
        WHERE binding.connector_instance_id = ?
          AND binding.binding_type = ?
          AND binding.local_id = ?
          AND binding.external_entity_id = ?
          AND binding.state = 'active'
          AND binding.verified_at = ?
          AND locator.locator_revision = ?
        LIMIT 1
      `).get(
        this.connectorInstanceId,
        bindingType,
        decision.selectedLocalId,
        decision.externalEntityId,
        decision.bindingRevision,
        decision.locatorRevision,
      );
      if (!current) throw new Error('GitHub stable decision binding or locator is stale');
    }
  }

  hasObservedStableLocalId(localId: string): boolean {
    return this.observedStableLocalIds.has(localId);
  }

  markIneligible(reasonCode: string): void {
    this.assertRunning();
    if (!/^[a-z0-9_]{3,100}$/.test(reasonCode)) {
      throw new Error('Comparison ineligibility reason must be a bounded machine code');
    }
    this.ineligibilityReasons.add(reasonCode);
  }

  recordSubIssueGeneration(input: {
    complete: boolean;
    expectedChildCount: number;
    expectedParentCount: number;
    populationCount: number;
    populationDigest: string;
    observedChildCount: number;
    observedChildDigest: string;
    populationMembers: readonly {
      localTaskId: string;
      sourceIdDigest: string;
      issueNumber: number;
      memberDigest: string;
      observed: boolean;
    }[];
  }): void {
    this.assertCurrentMode();
    if (
      !Number.isSafeInteger(input.expectedChildCount)
      || input.expectedChildCount < 0
      || !Number.isSafeInteger(input.expectedParentCount)
      || input.expectedParentCount < 0
      || input.expectedParentCount > input.expectedChildCount
      || !Number.isSafeInteger(input.populationCount)
      || input.populationCount < 0
      || !Number.isSafeInteger(input.observedChildCount)
      || input.observedChildCount < 0
      || !/^[a-f0-9]{64}$/.test(input.populationDigest)
      || !/^[a-f0-9]{64}$/.test(input.observedChildDigest)
      || input.populationMembers.length !== input.populationCount
      || input.populationMembers.some((member) =>
       !member.localTaskId
       || !Number.isSafeInteger(member.issueNumber)
       || member.issueNumber < 1
       || !/^[a-f0-9]{64}$/.test(member.sourceIdDigest)
       || !/^[a-f0-9]{64}$/.test(member.memberDigest))
    ) {
      throw new Error('Sub-issue generation counts are invalid');
    }
    const result = sqlite.transaction(() => {
      const update = sqlite.prepare(`
       UPDATE github_identity_comparison_runs
       SET sub_issue_generation_complete = ?,
           sub_issue_expected_child_count = ?,
           sub_issue_expected_parent_count = ?,
           sub_issue_population_count = ?,
           sub_issue_population_digest = ?,
           sub_issue_observed_child_count = ?,
           sub_issue_observed_child_digest = ?
       WHERE id = ? AND state = 'running' AND owner_token_digest = ?
      `).run(
       input.complete ? 1 : 0,
       input.expectedChildCount,
       input.expectedParentCount,
       input.populationCount,
       input.populationDigest,
       input.observedChildCount,
       input.observedChildDigest,
       this.runId,
       ownerTokenDigest(this.ownerToken),
      );
      if (update.changes !== 1) return update;
      sqlite.prepare(`
       DELETE FROM github_identity_sub_issue_population_members WHERE run_id = ?
      `).run(this.runId);
      const insert = sqlite.prepare(`
       INSERT INTO github_identity_sub_issue_population_members (
         id, run_id, local_task_id, source_id_digest, issue_number,
         member_digest, observed, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const createdAt = new Date().toISOString();
      for (const member of input.populationMembers) {
       insert.run(
         randomUUID(),
         this.runId,
         member.localTaskId,
         member.sourceIdDigest,
         member.issueNumber,
         member.memberDigest,
         member.observed ? 1 : 0,
         createdAt,
       );
      }
      return update;
    }).immediate();
    if (result.changes !== 1) {
      throw new Error('GitHub comparison run is not running');
    }
    if (!input.complete) this.markIneligible('sub_issue_generation_incomplete');
    this.subIssueGeneration = input;
  }

  observeBatch(
    surface: GitHubIdentityComparisonSurface,
    bindingType: ExternalBindingType,
    candidates: readonly GitHubComparisonObservationCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const lookup = resolveGitHubStableIdentityBatch(
      this.connectorInstanceId,
      candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        bindingType,
        evidence: candidate.evidence,
        applicableLocalIds: candidate.applicableStableLocalIds,
      })),
    );
    this.queryCount += lookup.queryCount;
    if (lookup.queryCount > 0) this.lookupLatencies.push(lookup.lookupMs);
    return this.persistDecisions(surface, candidates.map((candidate) => {
      const stable = lookup.resolutions.get(candidate.candidateKey);
      if (!stable) throw new Error(`Stable resolution is missing for ${candidate.candidateKey}`);
      return {
        ...candidate,
        stable: {
          ...stable,
          action: stable.selectedLocalIds.length > 0
            ? matchedStableAction(candidate.legacyAction)
            : candidate.unmatchedStableAction ?? unmatchedStableAction(candidate.legacyAction),
        },
      };
    }));
  }

  observeDeduplicatedBatch(
    surface: GitHubIdentityComparisonSurface,
    bindingType: ExternalBindingType,
    candidates: readonly GitHubComparisonObservationCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const seenCandidates = new Set<string>();
    const representativeByLookupKey = new Map<string, GitHubComparisonObservationCandidate>();
    for (const candidate of candidates) {
      if (seenCandidates.has(candidate.candidateKey)) {
        throw new Error(`Duplicate GitHub comparison candidate: ${candidate.candidateKey}`);
      }
      seenCandidates.add(candidate.candidateKey);
      if (candidate.evidence) {
        const lookupKey = stableLookupDedupKey(bindingType, candidate.evidence);
        const representative = representativeByLookupKey.get(lookupKey);
        if (
          representative
          && !sameLocalIdScope(
            representative.applicableStableLocalIds,
            candidate.applicableStableLocalIds,
          )
        ) {
          throw new Error(
            `Deduplicated GitHub comparison candidates have different local ID scopes: ${
              candidate.candidateKey
            }`,
          );
        }
        if (!representative) representativeByLookupKey.set(lookupKey, candidate);
      }
    }

    const stableByLookupKey = new Map<string, GitHubIdentityStableResolutionAlternative>();
    const representatives = [...representativeByLookupKey.entries()];
    for (let index = 0; index < representatives.length; index += 500) {
      const chunk = representatives.slice(index, index + 500);
      const lookup = resolveGitHubStableIdentityBatch(
        this.connectorInstanceId,
        chunk.map(([lookupKey, candidate]) => ({
          candidateKey: lookupKey,
          bindingType,
          evidence: candidate.evidence,
          applicableLocalIds: candidate.applicableStableLocalIds,
        })),
      );
      this.queryCount += lookup.queryCount;
      if (lookup.queryCount > 0) this.lookupLatencies.push(lookup.lookupMs);
      for (const [lookupKey] of chunk) {
        const stable = lookup.resolutions.get(lookupKey);
        if (!stable) throw new Error(`Stable resolution is missing for ${lookupKey}`);
        stableByLookupKey.set(lookupKey, stable);
      }
    }

    const decisions: GitHubIdentityResolutionDecision[] = [];
    for (let index = 0; index < candidates.length; index += 500) {
      const chunk = candidates.slice(index, index + 500);
      decisions.push(...this.persistDecisions(surface, chunk.map((candidate) => {
        const stable = candidate.evidence
          ? stableByLookupKey.get(stableLookupDedupKey(bindingType, candidate.evidence))
          : {
              selectedLocalIds: [],
              action: 'none' as const,
              evidence: 'missing' as const,
            };
        if (!stable) {
          throw new Error(`Stable resolution is missing for ${candidate.candidateKey}`);
        }
        return {
          ...candidate,
          stable: {
            ...stable,
            action: stable.selectedLocalIds.length > 0
              ? matchedStableAction(candidate.legacyAction)
              : candidate.unmatchedStableAction ?? unmatchedStableAction(candidate.legacyAction),
          },
        };
      })));
    }
    return decisions;
  }

  observeResolvedBatch(
    surface: GitHubIdentityComparisonSurface,
    candidates: readonly GitHubComparisonResolvedCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    return this.persistDecisions(surface, candidates);
  }

  observeLinkedSourceBatch(
    candidates: readonly GitHubLinkedSourceIdentityCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const lookup = resolveGitHubLinkedSourceIdentityBatch(
      this.connectorInstanceId,
      candidates,
    );
    this.queryCount += lookup.queryCount;
    if (lookup.queryCount > 0) this.lookupLatencies.push(lookup.lookupMs);
    const decisions = this.persistDecisions('linked_source', candidates.map((candidate) => {
      const stable = lookup.resolutions.get(candidate.candidateKey);
      if (!stable) {
        throw new Error(`Stable linked-source resolution is missing for ${candidate.candidateKey}`);
      }
      return {
        candidateKey: candidate.candidateKey,
        legacySelectedLocalIds: [candidate.taskId],
        legacyAction: 'present',
        localTaskId: candidate.taskId,
        stable,
      };
    }));
    for (const decision of decisions) {
      if (decision.outcome !== 'agreement' && decision.outcome !== 'locator_change') {
        this.markIneligible(`linked_source_${decision.outcome}`);
      }
    }
    return decisions;
  }

  complete(state: Exclude<GitHubIdentityComparisonRunState, 'running'>, errorCode?: string): void {
    this.finish(
      state,
      errorCode,
      (input) => completeGitHubIdentityComparisonRun(this.runId, input),
    );
  }

  completeInTransaction(
    database: ExternalIdentityTransaction,
    state: Exclude<GitHubIdentityComparisonRunState, 'running'>,
    errorCode?: string,
  ): void {
    this.finish(
      state,
      errorCode,
      (input) => completeGitHubIdentityComparisonRunInTransaction(
        database,
        this.runId,
        input,
      ),
    );
  }

  private finish(
    state: Exclude<GitHubIdentityComparisonRunState, 'running'>,
    errorCode: string | undefined,
    persist: (
      input: Parameters<typeof completeGitHubIdentityComparisonRun>[1],
    ) => unknown,
  ): void {
    if (this.completed) return;
    const outcomeRows = sqlite.prepare(`
      SELECT outcome, COUNT(*) AS count
      FROM github_identity_comparison_records
      WHERE run_id = ?
      GROUP BY outcome
    `).all(this.runId) as Array<{ outcome: string; count: number }>;
    const outcomeCounts = Object.fromEntries(
      outcomeRows.map((row) => [row.outcome, row.count]),
    );
    const sorted = [...this.lookupLatencies].sort((left, right) => left - right);
    persist({
      state,
      pageCount: this.pageCount,
      queryCount: this.queryCount,
      outcomeCounts,
      lookupLatencyP50Ms: percentile(sorted, 0.5),
      lookupLatencyP95Ms: percentile(sorted, 0.95),
      lookupLatencyP99Ms: percentile(sorted, 0.99),
      evidenceEligible: state === 'succeeded'
        && this.syncKind === 'full'
        && this.ineligibilityReasons.size === 0
        && !hasUnexplainedBlockingEvidence(this.runId),
      ownerToken: this.ownerToken,
      subIssueGenerationComplete: this.subIssueGeneration.complete,
      subIssueExpectedChildCount: this.subIssueGeneration.expectedChildCount,
      subIssueExpectedParentCount: this.subIssueGeneration.expectedParentCount,
      subIssuePopulationCount: this.subIssueGeneration.populationCount,
      subIssuePopulationDigest: this.subIssueGeneration.populationDigest,
      subIssueObservedChildCount: this.subIssueGeneration.observedChildCount,
      subIssueObservedChildDigest: this.subIssueGeneration.observedChildDigest,
      errorCode: errorCode ?? this.ineligibilityReasons.values().next().value,
    });
    this.completed = true;
  }

  private persistDecisions(
    surface: GitHubIdentityComparisonSurface,
    candidates: readonly GitHubComparisonResolvedCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertCurrentMode();
    const result = resolveGitHubIdentityBatch({
      modeSnapshot: this.modeSnapshot,
      candidates: candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        surface,
        localTaskId: candidate.localTaskId,
        localSourceListId: candidate.localSourceListId,
        legacy: {
          selectedLocalIds: candidate.legacySelectedLocalIds,
          action: candidate.legacyAction,
        },
        stable: candidate.stable,
      } satisfies GitHubIdentityResolutionCandidate)),
    });
    appendGitHubIdentityComparisonRecords(this.runId, result.decisions.map((decision) => ({
      jobId: this.jobId,
      surface: decision.surface,
      candidateKey: decision.candidateKey,
      localTaskId: decision.localTaskId,
      localSourceListId: decision.localSourceListId,
      externalEntityId: decision.externalEntityId,
      legacySelectedLocalId: decision.legacySelectedLocalId,
      stableSelectedLocalId: decision.stableSelectedLocalId,
      legacyAction: decision.legacyAction,
      stableAction: decision.stableAction,
      outcome: decision.outcome,
      reason: decision.reason,
      stableIdDigest: decision.stableIdDigest,
      locatorRevision: decision.locatorRevision,
      legacyLookupMs: decision.legacyLookupMs,
      stableLookupMs: decision.stableLookupMs,
    })), this.ownerToken);
    for (const decision of result.decisions) {
      if (
        decision.stableSelectedLocalId
        && decision.outcome !== 'collision'
        && decision.outcome !== 'inaccessible'
        && decision.outcome !== 'partial_fetch'
      ) {
        this.observedStableLocalIds.add(decision.stableSelectedLocalId);
      }
      if (
        this.modeSnapshot.effectiveMode === 'stable'
        && decision.appliedSource === 'blocked'
        && !isAcceptedTerminalInaccessibleDeletion(
          this.connectorInstanceId,
          decision,
        )
      ) {
        this.ineligibilityReasons.add(`stable_${decision.outcome}`);
      }
    }
    return result.decisions;
  }

  private assertRunning(): void {
    if (this.completed) throw new Error('GitHub comparison runtime is already complete');
  }
}

function matchedStableAction(
  legacyAction: GitHubIdentityComparisonAction,
): GitHubIdentityComparisonAction {
  return legacyAction === 'create' ? 'present' : legacyAction;
}

function unmatchedStableAction(
  legacyAction: GitHubIdentityComparisonAction,
): GitHubIdentityComparisonAction {
  if (legacyAction === 'delete_candidate' || legacyAction === 'present') return 'none';
  return legacyAction;
}

function stableLookupDedupKey(
  bindingType: ExternalBindingType,
  evidence: ExternalIdentityEvidence,
): string {
  const { identity, locator } = evidence.entity;
  return JSON.stringify([
    bindingType,
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
    locator.owner.toLowerCase(),
    locator.repository.toLowerCase(),
    locator.issueNumber ?? null,
  ]);
}

function sameLocalIdScope(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  return [...left].every((localId) => right.has(localId));
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function ownerTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hasUnexplainedBlockingEvidence(runId: string): boolean {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS value
    FROM github_identity_comparison_records AS record
    WHERE record.run_id = ?
      AND (
        record.outcome IN ('collision', 'stable_legacy_disagree', 'path_reuse', 'partial_fetch')
        OR (
          record.outcome = 'inaccessible'
          AND (
            record.surface <> 'deletion'
            OR record.reason <> 'access_denied'
            OR NOT EXISTS (
              SELECT 1
              FROM github_identity_exception_events AS exception
              WHERE exception.connector_instance_id = (
                SELECT connector_instance_id
                FROM github_identity_comparison_runs
                WHERE id = record.run_id
              )
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
        )
      )
  `).get(runId) as { value: number };
  return row.value > 0;
}

function isAcceptedTerminalInaccessibleDeletion(
  connectorInstanceId: string,
  decision: GitHubIdentityResolutionDecision,
): boolean {
  return decision.surface === 'deletion'
    && decision.outcome === 'inaccessible'
    && decision.reason === 'access_denied'
    && decision.localTaskId !== null
    && hasAcceptedGitHubTerminalInaccessibleException(
      connectorInstanceId,
      'task',
      decision.localTaskId,
    );
}
