export * from './types';
export * from './stable-identity-types';
export * from './github-backfill';
export {
  createGitHubIdentityCacheGeneration,
  resolveGitHubIdentityBatch,
} from './resolver';
export {
  assertGitHubIdentityModeSnapshotInTransaction,
  ensureGitHubIdentityControlsInTransaction,
  getGitHubIdentityModeSnapshot,
  getGitHubIdentityModeSnapshotInTransaction,
} from './identity-mode';
export {
  getLatestGitHubIdentityException,
  hasAcceptedGitHubTerminalInaccessibleException,
  recordGitHubIdentityException,
  recordGitHubIdentityExceptionInTransaction,
} from './identity-exceptions';
export type { GitHubIdentityExceptionEvent } from './identity-exceptions';
export {
  resolveGitHubStableIdentityBatch,
} from './stable-lookup';
export type {
  GitHubStableLookupCandidate,
  GitHubStableLookupResult,
} from './stable-lookup';
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
export { GitHubStableIdentityRuntime } from './stable-identity-runtime';
export type {
  GitHubStableIdentityCandidate,
  GitHubStableResolvedCandidate,
  GitHubStableIdentityRuntimeOptions,
} from './stable-identity-runtime';
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
export { getGitHubIdentityStatus } from './identity-status';
export type { GitHubIdentityStatusOptions } from './identity-status';
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
  assertExternalIdentityBatchWithinLimit,
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
