import type { ExternalBindingType } from '@/db/schema';

/**
 * GitHub identity is permanently NodeID-first. `external_entities.stable_id`
 * (the GitHub NodeID) is the only identity; `tasks.source_id`,
 * `source_lists.source_id` and `task_linked_sources.source_id` are mutable
 * locators used for API addressing and display, and they may keep changing on
 * rename or transfer. Nothing in this module may fall back to a locator when
 * NodeID evidence is missing or unverified.
 */
export const GITHUB_IDENTITY_MODE = 'stable' as const;

export type GitHubIdentitySurface =
  | 'source_list'
  | 'task'
  | 'project_association'
  | 'dependency'
  | 'sub_issue'
  | 'linked_source'
  | 'deletion'
  | 'write_route';

export type GitHubIdentityAction =
  | 'create'
  | 'update'
  | 'present'
  | 'delete_candidate'
  | 'none';

/**
 * Only `resolved` and `locator_change` are applied. Every other outcome blocks
 * the caller: unverified NodeID evidence must fail explicitly rather than fall
 * back to locator identity.
 */
export type GitHubIdentityOutcome =
  | 'resolved'
  | 'locator_change'
  | 'missing_stable_id'
  | 'unbound_local_row'
  | 'collision'
  | 'inaccessible'
  | 'partial_fetch'
  | 'path_reuse';

export type GitHubIdentityReason =
  | 'stable_binding_match'
  | 'current_locator_changed'
  | 'missing_stable_evidence'
  | 'local_row_missing_stable_binding'
  | 'multiple_stable_bindings'
  | 'multiple_locator_matches'
  | 'binding_not_active'
  | 'locator_owned_by_other_entity'
  | 'access_denied'
  | 'fetch_incomplete';

export interface GitHubIdentityModeSnapshot {
  connectorInstanceId: string;
  /** Permanently `'stable'`; retained so durable fences stay self-describing. */
  effectiveMode: typeof GITHUB_IDENTITY_MODE;
  /** Durable identity epoch used to fence in-flight write cycles and leases. */
  modeRevision: number;
  capturedAt: string;
}

export interface GitHubIdentityRunContext {
  connectorInstanceId: string;
  modeRevision: number;
}

export interface GitHubStableResolution {
  /** Local rows the NodeID binding resolved to. */
  selectedLocalIds: readonly string[];
  action: GitHubIdentityAction;
  evidence: 'verified' | 'missing' | 'collision' | 'inaccessible' | 'partial';
  externalEntityId?: string;
  stableIdDigest?: string;
  locatorRevision?: number;
  bindingRevision?: string;
  bindingState?: 'shadow' | 'active' | 'collision' | 'retired';
  locatorChanged?: boolean;
  pathReused?: boolean;
  lookupMs?: number;
}

export interface GitHubIdentityResolutionCandidate {
  candidateKey: string;
  surface: GitHubIdentitySurface;
  localTaskId?: string;
  localSourceListId?: string;
  /**
   * Local rows the caller matched by mutable locator. This is only a guard: a
   * locator match without a NodeID binding blocks the candidate so sync can
   * never duplicate or adopt a row on locator evidence alone.
   */
  locatorMatchedLocalIds?: readonly string[];
  stable: GitHubStableResolution;
}

export interface GitHubIdentityResolutionDecision {
  candidateKey: string;
  surface: GitHubIdentitySurface;
  localTaskId: string | null;
  localSourceListId: string | null;
  externalEntityId: string | null;
  selectedLocalId: string | null;
  selectedAction: GitHubIdentityAction;
  outcome: GitHubIdentityOutcome;
  reason: GitHubIdentityReason;
  appliedSource: 'stable' | 'blocked';
  /** True when the NodeID binding disagreed with the caller's locator match. */
  locatorMatchSuperseded: boolean;
  stableIdDigest: string | null;
  locatorRevision: number | null;
  bindingRevision: string | null;
  lookupMs: number;
}

export interface GitHubIdentityBatchResolutionInput {
  modeSnapshot: GitHubIdentityModeSnapshot;
  candidates: readonly GitHubIdentityResolutionCandidate[];
}

export interface GitHubIdentityBatchResolution {
  modeSnapshot: GitHubIdentityModeSnapshot;
  decisions: readonly GitHubIdentityResolutionDecision[];
  outcomeCounts: Readonly<Partial<Record<GitHubIdentityOutcome, number>>>;
}

export interface GitHubIdentityExceptionRequest {
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  category: 'terminal_inaccessible';
  action: 'accept' | 'revoke';
  actor: string;
  reason: string;
  idempotencyKey: string;
  /**
   * Required to accept a terminal exception for a task that already carries a
   * verified NodeID binding, where Stage-1 inaccessibility is not the proof.
   */
  confirmAuthoritativeDeletion?: boolean;
  now?: string;
}

export interface GitHubIdentityExceptionResult {
  changed: boolean;
  eventId: number;
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  category: 'terminal_inaccessible';
  action: 'accept' | 'revoke';
  proofType: 'stage1_inaccessible' | 'post_backfill_authoritative_deletion'
    | 'legacy_comparison_evidence' | null;
}
