import type {
  GitHubIdentityComparisonAction,
  GitHubIdentityComparisonOutcome,
  GitHubIdentityComparisonReason,
  GitHubIdentityComparisonRunState,
  GitHubIdentityComparisonSurface,
  GitHubIdentityEffectiveMode,
  GitHubIdentityExceptionAction,
  GitHubIdentityExceptionCategory,
  GitHubIdentityExceptionProofType,
  GitHubIdentityPhase,
} from '@/db/schema';
import type { ExternalBindingType } from '@/db/schema';

export type GitHubIdentityTransitionGateCode =
  | 'stage_one_ready'
  | 'stage_two_ready'
  | 'stage_three_ready'
  | 'compatibility_ready'
  | 'pause'
  | 'rollback'
  | 'rollback_verified';

export type GitHubIdentityTransitionRejectionCode =
  | 'invalid_request'
  | 'missing_state'
  | 'revision_conflict'
  | 'invalid_transition'
  | 'authoritative_command_required'
  | 'gate_required'
  | 'gate_failed'
  | 'stable_flag_required'
  | 'idempotency_conflict';

export interface GitHubIdentityModeSnapshot {
  connectorInstanceId: string;
  phase: GitHubIdentityPhase | null;
  effectiveMode: GitHubIdentityEffectiveMode;
  stablePrimaryEnabled: boolean;
  modeRevision: number;
  capturedAt: string;
}

export interface GitHubIdentityRunContext {
  connectorInstanceId: string;
  effectiveMode: GitHubIdentityEffectiveMode;
  modeRevision: number;
}

export interface GitHubIdentityTransitionGate {
  code: GitHubIdentityTransitionGateCode;
  passed: boolean;
}

export interface GitHubIdentityTransitionRequest {
  connectorInstanceId: string;
  targetPhase: GitHubIdentityPhase;
  stablePrimaryEnabled?: boolean;
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
  gate?: GitHubIdentityTransitionGate;
  now?: string;
}

export type GitHubIdentityTransitionResult =
  | {
      ok: true;
      changed: boolean;
      eventId: number | null;
      snapshot: GitHubIdentityModeSnapshot;
    }
  | {
      ok: false;
      code: GitHubIdentityTransitionRejectionCode;
      message: string;
      snapshot?: GitHubIdentityModeSnapshot;
    };

export interface GitHubIdentityResolutionAlternative {
  selectedLocalIds: readonly string[];
  action: GitHubIdentityComparisonAction;
  lookupMs?: number;
}

export interface GitHubIdentityStableResolutionAlternative
  extends GitHubIdentityResolutionAlternative {
  evidence: 'verified' | 'missing' | 'collision' | 'inaccessible' | 'partial';
  externalEntityId?: string;
  stableIdDigest?: string;
  locatorRevision?: number;
  bindingRevision?: string;
  bindingState?: 'shadow' | 'active' | 'collision' | 'retired';
  locatorChanged?: boolean;
  pathReused?: boolean;
}

export interface GitHubIdentityResolutionCandidate {
  candidateKey: string;
  surface: GitHubIdentityComparisonSurface;
  localTaskId?: string;
  localSourceListId?: string;
  legacy: GitHubIdentityResolutionAlternative;
  stable: GitHubIdentityStableResolutionAlternative;
}

export interface GitHubIdentityResolutionDecision {
  candidateKey: string;
  surface: GitHubIdentityComparisonSurface;
  localTaskId: string | null;
  localSourceListId: string | null;
  externalEntityId: string | null;
  legacySelectedLocalId: string | null;
  stableSelectedLocalId: string | null;
  legacyAction: GitHubIdentityComparisonAction;
  stableAction: GitHubIdentityComparisonAction;
  outcome: GitHubIdentityComparisonOutcome;
  reason: GitHubIdentityComparisonReason;
  appliedSource: 'legacy' | 'stable' | 'blocked';
  selectedLocalId: string | null;
  selectedAction: GitHubIdentityComparisonAction;
  stableIdDigest: string | null;
  locatorRevision: number | null;
  bindingRevision: string | null;
  legacyLookupMs: number;
  stableLookupMs: number;
}

export interface GitHubIdentityBatchResolutionInput {
  modeSnapshot: GitHubIdentityModeSnapshot;
  candidates: readonly GitHubIdentityResolutionCandidate[];
}

export interface GitHubIdentityBatchResolution {
  modeSnapshot: GitHubIdentityModeSnapshot;
  decisions: readonly GitHubIdentityResolutionDecision[];
  outcomeCounts: Readonly<Partial<Record<GitHubIdentityComparisonOutcome, number>>>;
}

export interface StartGitHubIdentityComparisonRunInput {
  id?: string;
  connectorInstanceId: string;
  jobId?: string;
  identityMode: GitHubIdentityEffectiveMode;
  identityModeRevision: number;
  syncKind: 'full' | 'incremental';
  ownerId?: string;
  ownerToken?: string;
  ownerLeaseSeconds?: number;
  startedAt?: string;
}

export interface AppendGitHubIdentityComparisonRecordInput {
  id?: string;
  jobId?: string;
  surface: GitHubIdentityComparisonSurface;
  candidateKey: string;
  localTaskId?: string | null;
  localSourceListId?: string | null;
  externalEntityId?: string | null;
  legacySelectedLocalId?: string | null;
  stableSelectedLocalId?: string | null;
  legacyAction: GitHubIdentityComparisonAction;
  stableAction: GitHubIdentityComparisonAction;
  outcome: GitHubIdentityComparisonOutcome;
  reason: GitHubIdentityComparisonReason;
  stableIdDigest?: string | null;
  locatorRevision?: number | null;
  legacyLookupMs?: number;
  stableLookupMs?: number;
  createdAt?: string;
}

export interface CompleteGitHubIdentityComparisonRunInput {
  state: Exclude<GitHubIdentityComparisonRunState, 'running'>;
  pageCount: number;
  queryCount: number;
  outcomeCounts: Partial<Record<GitHubIdentityComparisonOutcome, number>>;
  lookupLatencyP50Ms?: number | null;
  lookupLatencyP95Ms?: number | null;
  lookupLatencyP99Ms?: number | null;
  evidenceEligible: boolean;
  ownerToken?: string;
  subIssueGenerationComplete?: boolean;
  subIssueExpectedChildCount?: number;
  subIssueExpectedParentCount?: number;
  subIssuePopulationCount?: number;
  subIssuePopulationDigest?: string | null;
  subIssueObservedChildCount?: number;
  subIssueObservedChildDigest?: string | null;
  interruptionSurface?: 'comparison' | 'sub_issue';
  completedAt?: string;
  errorCode?: string | null;
}

export interface GitHubIdentityExceptionRequest {
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  category: GitHubIdentityExceptionCategory;
  action: GitHubIdentityExceptionAction;
  actor: string;
  reason: string;
  idempotencyKey: string;
  comparisonRunId?: string;
  confirmAuthoritativeDeletion?: boolean;
  now?: string;
}

export interface GitHubIdentityExceptionResult {
  changed: boolean;
  eventId: number;
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  category: GitHubIdentityExceptionCategory;
  action: GitHubIdentityExceptionAction;
  proofType: GitHubIdentityExceptionProofType | null;
  comparisonRunId: string | null;
}
