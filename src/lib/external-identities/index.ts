export * from './types';
export * from './comparison-types';
export * from './github-backfill';
export {
  createGitHubIdentityCacheGeneration,
  resolveGitHubIdentityBatch,
} from './resolver';
export {
  deriveGitHubIdentityEffectiveMode,
  getGitHubIdentityModeSnapshot,
  getGitHubIdentityModeSnapshotInTransaction,
  transitionGitHubIdentityMode,
  transitionGitHubIdentityModeInTransaction,
} from './mode-control';
export {
  enableGitHubStablePrimary,
  rollbackGitHubStablePrimary,
} from './stable-primary';
export type { GitHubStablePrimaryCommand } from './stable-primary';
export {
  appendGitHubIdentityComparisonRecords,
  appendGitHubIdentityComparisonRecordsInTransaction,
  completeGitHubIdentityComparisonRun,
  completeGitHubIdentityComparisonRunInTransaction,
  startGitHubIdentityComparisonRun,
  startGitHubIdentityComparisonRunInTransaction,
} from './comparison-service';
export type {
  GitHubIdentityComparisonDecisionRecord,
  GitHubIdentityComparisonRunRecord,
} from './comparison-service';
export {
  getLatestGitHubIdentityException,
  recordGitHubIdentityException,
  recordGitHubIdentityExceptionInTransaction,
} from './compatibility-exceptions';
export type { GitHubIdentityExceptionEvent } from './compatibility-exceptions';
export {
  resolveGitHubStableIdentityBatch,
} from './comparison-query';
export type {
  GitHubStableLookupCandidate,
  GitHubStableLookupResult,
} from './comparison-query';
export {
  persistGitHubLinkedSourceIdentityBatch,
  resolveGitHubLinkedSourceIdentityBatch,
} from './linked-source-identity';
export type {
  GitHubLinkedSourceEvidenceState,
  GitHubLinkedSourceIdentityCandidate,
  GitHubLinkedSourceIdentityWrite,
  GitHubLinkedSourceIdentityWriteResult,
} from './linked-source-identity';
export { GitHubIdentityComparisonRuntime } from './comparison-runtime';
export type {
  GitHubComparisonObservationCandidate,
  GitHubComparisonResolvedCandidate,
  GitHubIdentityComparisonRuntimeOptions,
} from './comparison-runtime';
export {
  GitHubWriteFenceError,
  GitHubUnknownWriteOutcomeError,
  authorizeGitHubWrite,
  authorizeGitHubSourceWrite,
  assertGitHubWriteCycleCurrent,
  confirmGitHubWriteDispatch,
  verifyGitHubWritePreflight,
  finalizeGitHubWrite,
  quarantineUnknownGitHubWrite,
  blockGitHubWrite,
  beginGitHubWriteCycle,
  finishGitHubWriteCycle,
  hasSucceededGitHubWrite,
  expireUndispatchedGitHubWriteLeases,
  executeFencedGitHubTaskMutation,
  executeFencedGitHubSourceMutation,
} from './github-write-fence';
export type { FencedGitHubConnector, GitHubWriteAuthorization } from './github-write-fence';
export {
  reconcileInterruptedGitHubWriteCycle,
} from './write-cycle-reconciliation';
export type {
  GitHubWriteCycleReconciliationCommand,
  GitHubWriteCycleReconciliationResult,
} from './write-cycle-reconciliation';
export {
  inspectGitHubWriteOutcomes,
  resolveGitHubWriteOutcome,
} from './write-outcome-resolution';
export type {
  GitHubWriteOutcomeReadRequest,
  GitHubWriteOutcomeReadResult,
  GitHubWriteOutcomeReader,
  GitHubWriteOutcomeResolutionCommand,
  GitHubWriteOutcomeResolutionResult,
} from './write-outcome-resolution';
export {
  getGitHubIdentityComparisonStatus,
  getGitHubStablePrimaryEligibility,
} from './comparison-status';
export type {
  GitHubIdentityComparisonStatusOptions,
  GitHubStablePrimaryEligibility,
} from './comparison-status';
export {
  reconcileGitHubComparisonCycle,
} from './comparison-cycle-reconciliation';
export type {
  GitHubComparisonCycleReconciliationCommand,
  GitHubComparisonCycleReconciliationResult,
} from './comparison-cycle-reconciliation';
export {
  provenSupersededGitHubTaskIds,
  readGitHubTaskTransferBinding,
  recordGitHubTaskTransferReconciliation,
} from './task-transfer-reconciliation';
export type {
  GitHubHistoricalTransferObservation,
  GitHubTaskTransferBinding,
  GitHubTaskTransferReconciliationRequest,
  GitHubTaskTransferReconciliationResult,
} from './task-transfer-reconciliation';
export {
  canWriteShadowIdentity,
  createExternalEntityKey,
  createNewGitHubConnectorIdentityState,
  digestExternalIdentifier,
  getCurrentExternalEntityLocator,
  getCurrentExternalEntityLocatorInTransaction,
  getExternalEntityByKey,
  getExternalEntityByKeyInTransaction,
  getGitHubIdentityPhase,
  listExternalEntityLocatorHistory,
  listExternalEntityLocatorHistoryInTransaction,
  normalizeExternalEntityLocator,
  observeOperatorExternalEntityLocator,
  observeOperatorExternalEntityLocatorInTransaction,
  persistExternalIdentityBatch,
  persistExternalIdentityBatchInTransaction,
  preflightExternalEntityLocator,
  preflightExternalEntityLocatorInTransaction,
  recordExternalIdentityCollision,
  recordExternalIdentityCollisionInTransaction,
  upsertExternalEntity,
  upsertExternalEntityInTransaction,
  updateGitHubIdentityPhase,
} from './service';
export type { ExternalIdentityTransaction } from './service';
