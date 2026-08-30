/**
 * Schema barrel file — re-exports ALL tables from domain modules.
 * Ensures full backwards compatibility: any consumer importing from
 * '@/db/schema' continues to work without changes.
 */

// Connectors, sync, integrations, webhooks
export {
  connectorConfigs,
  listGroups,
  sourceLists,
  workTodoBridgeState,
  workTodoListDeltaState,
  workTodoOutboundChanges,
  syncLog,
  syncJobs,
  connectorOperationLeases,
  syncJobEvents,
  runtimeTelemetry,
  runtimeTelemetryInstances,
  runtimeTelemetrySamples,
  workerHealthSnapshot,
  syncSchedules,
  connectorSyncControls,
  connectorSyncOperatorRuns,
  syncDeletionCandidates,
  syncDeletionSnapshots,
  dependencyReconciliationSnapshots,
  dependencyReconciliationItems,
  dependencyReconciliationEdges,
  dependencyReconciliationCandidates,
  outboundWebhooks,
  integrationConfigs,
  inboundWebhooks,
  inboundWebhookLog,
  inboundWebhookReplays,
  listFixAuditLog,
  appSettings,
} from './connectors';

// Tasks, tags, scoring, routines
export {
  tasks,
  taskReminderOccurrences,
  taskSchedules,
  tags,
  taskTags,
  taskProjects,
  taskHistoryEvents,
  taskFieldStates,
  taskIngestSuppressions,
  taskDependencies,
  myDayItems,
  myDayExclusions,
  focusItems,
  weeklyOneThing,
  prioritySyncLog,
  subtaskTemplates,
  priorityEntities,
  sourceRankings,
  smartScoreSettings,
  routines,
  routineCompletions,
  energyCheckins,
  resets,
  quickSortLog,
  quickSortOperations,
  taskAttachments,
  taskLinkedSources,
} from './tasks';

// Triage
export {
  triageActionClaims,
  triageContentTypes,
  triageItems,
  triageSyncState,
} from './triage';

// Projects
export {
  hubProjects,
  projectTags,
  projectAutoIncludeExclusions,
  projectMilestones,
  projectPhases,
  projectPhaseItems,
  projectHierarchyCommands,
  projectHierarchyMutationContext,
} from './projects';

// User-authored graph workspace artifacts and immutable checkpoints
export {
  graphWorkspaces,
  graphWorkspaceVersions,
} from './graph-workspaces';

// Notifications
export {
  notifications,
  notificationActions,
  notificationSavedViews,
} from './notifications';

// PostgreSQL-only keyword search-index projections for tasks/notifications
// (no SQLite counterpart — see src/db/postgres/schema/search-index.ts for
// why these are excluded from the SQLite<->PostgreSQL schema-parity checks).
export {
  taskSearchDocuments,
  notificationSearchDocuments,
} from './search-index';

// Scout reconciliation runs, evidence, proposals, and task policy state
export {
  scoutReconciliationRuns,
  scoutReconciliationEvaluations,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
} from './scout-reconciliation';
export type { ReconciliationEvidenceSummary } from './scout-reconciliation';

// Provider-neutral durable AI runs, progress history, and protected sessions
export {
  aiRuns,
  aiRunEvents,
  aiProviderSessions,
} from './ai-runs';
export type {
  AiRunCleanupStatus,
  AiRunFallbackState,
  AiRunSensitivity,
  AiRunStatus,
} from './ai-runs';

// Homelab alert lifecycle receipts and integration telemetry
export {
  alertmanagerIntegrationEvents,
  homelabAlertReceipts,
} from './homelab';

// Durable checkpoints and leases for bounded bulk maintenance agents
export { maintenanceAgentRuns } from './maintenance-agents';
export type { MaintenanceAgentRunStatus } from './maintenance-agents';

// Provider-neutral external identities and GitHub NodeID backfill state
export {
  GITHUB_TASK_WRITE_OPERATIONS,
  GITHUB_TASK_WRITE_LEASE_STATES,
  GITHUB_WRITE_CYCLE_RECONCILIATION_STATES,
  GITHUB_IDENTITY_EXCEPTION_ACTIONS,
  GITHUB_IDENTITY_EXCEPTION_CATEGORIES,
  GITHUB_IDENTITY_EXCEPTION_PROOF_TYPES,
  GITHUB_IDENTITY_EXCEPTION_ARCHIVAL_PROOF_TYPE,
  externalEntities,
  externalEntityBindings,
  externalEntityLocators,
  githubIdentityMigrations,
  githubIdentityControls,
  githubIdentityModeEvents,
  taskSourceWriteLeases,
  taskSourceWriteLeaseTargets,
  githubIdentityWriteCycles,
  githubWriteOutcomeEvents,
  githubIdentityExceptionEvents,
  githubIdentityTaskTransferReconciliations,
  githubIdentityBackfillItems,
  githubIdentityCollisions,
  githubRepositoryRepoints,
  githubRepositoryRepointEvents,
  githubBulkTransferRuns,
  githubBulkTransferItems,
  githubBulkTransferSuccessions,
  githubBulkTransferEvents,
  connectorMaintenanceLocks,
  EXTERNAL_ENTITY_TYPES,
  EXTERNAL_BINDING_TYPES,
  EXTERNAL_BINDING_STATES,
  EXTERNAL_LOCATOR_SOURCES,
  GITHUB_IDENTITY_PHASES,
  GITHUB_BACKFILL_STATES,
  GITHUB_COLLISION_CATEGORIES,
  GITHUB_COLLISION_STATES,
  GITHUB_REPOSITORY_REPOINT_PHASES,
  GITHUB_BULK_TRANSFER_PHASES,
  GITHUB_BULK_TRANSFER_ITEM_STATES,
} from './external-identities';
export type {
  GitHubTaskWriteOperation,
  GitHubTaskWriteLeaseState,
  GitHubWriteCycleReconciliationState,
  GitHubIdentityExceptionAction,
  GitHubIdentityExceptionCategory,
  GitHubIdentityExceptionProofType,
  GitHubIdentityExceptionStoredProofType,
} from './external-identities';
export type {
  ExternalEntityType,
  ExternalBindingType,
  ExternalBindingState,
  ExternalLocatorSource,
  GitHubIdentityPhase,
  GitHubBackfillState,
  GitHubCollisionCategory,
  GitHubCollisionState,
  GitHubIdentityCounters,
  GitHubCollisionResolution,
  GitHubRepositoryRepointPhase,
  GitHubBulkTransferPhase,
  GitHubBulkTransferItemState,
} from './external-identities';

// Stable identity associations for cross-connector provenance rows
export { taskLinkedSourceEntities } from './linked-source-identities';

// External-agent registry, dispatch lifecycle, attempts, and audit events
export {
  externalAgents,
  agentDispatches,
  agentDispatchAttempts,
  agentDispatchEvents,
  EXTERNAL_AGENT_TYPES,
  EXTERNAL_AGENT_TRANSPORTS,
  EXTERNAL_AGENT_LOCALITIES,
  EXTERNAL_AGENT_AUTH_TYPES,
  AGENT_DATA_CLASSIFICATIONS,
  AGENT_DISPATCH_STATUSES,
  AGENT_RESULT_STATUSES,
} from './external-agents';
export type {
  ExternalAgentType,
  ExternalAgentTransport,
  ExternalAgentLocality,
  ExternalAgentAuthType,
  AgentDataClassification,
  AgentDispatchStatus,
  AgentResultStatus,
  ExternalAgentCapabilities,
  ExternalAgentDataPolicy,
  AgentDispatchScope,
  AgentResultReference,
  AgentDispatchResult,
} from './external-agents';

// Push subscriptions & preferences
export {
  pushSubscriptions,
  pushPreferences,
  notificationPushRules,
  notificationDeliveryEvents,
  notificationWritebackJobs,
} from './push';

// Native iOS credentials, APNs registrations, and request idempotency
export {
  nativeInstallationCredentials,
  nativeShareCredentials,
  nativeShareCaptureRequests,
  apnsRegistrations,
  nativePushRequests,
} from './native';

// Finance (re-exported from separate file)
export {
  financeTransactions,
  financeSyncState,
  financeConnectionOutages,
  financeInsightPublicationState,
  financeInsightPublicationDelivery,
  financeInsightPublications,
  financeInsightPublicationFacts,
  financeInsightOccurrenceCacheState,
  financeInsightOccurrences,
  financeInsightCutovers,
  financeInsightCutoverAudit,
  financeInsightTransactionBackfillPlans,
  financeInsightTransactionProjectionFacts,
  financeInsightTransactionProjectionState,
  financeInsightTransactionProjectionWindows,
  financeInsightTransactionWindowProofs,
  financeDatasetSyncState,
  financeAccounts,
  financeCategoryGroups,
  financeCategories,
  financeTags,
  financeRecurringObligations,
  financeBudgetSnapshots,
  financeMutationAudit,
  houstonFinanceActionAudit,
  houstonFinancePendingApprovals,
  financeAttributionSubjects,
  financeAttributionExceptions,
  financeAttributionAudit,
  financeAttentionRepairAudit,
  kidProfiles,
  kidCardRules,
  kidMerchantRules,
  financeAlertConfigs,
  FINANCE_DATASETS,
} from './finance';
export type {
  FinanceDataset,
  FinanceFreshnessState,
} from './finance';
