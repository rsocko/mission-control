import 'server-only';

import type { GitHubParentMetadata } from '@/lib/connectors/github-issues/issue-transformer';
import type { GitHubStableIdentityRuntime, GitHubStableIdentityCandidate } from '@/lib/external-identities/stable-identity-runtime';
import type { GitHubIdentityResolutionDecision } from '@/lib/external-identities/stable-identity-types';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { TaskItem } from '@/types';
import type {
  GitHubHierarchyExceptionEventRow,
  GitHubHierarchyStableBindingRow,
  GitHubHierarchyTaskIdentityRow,
  GitHubHierarchyTaskRow,
  GitHubHierarchyTaskUpdate,
} from '@/db/persistence/github-hierarchy';
import {
  buildGitHubNativeTaskPopulation,
  canonicalizeGitHubSourceId,
  digestGitHubTaskPopulationMembers,
  isConnectorNativeTask,
  parseNativeGitHubTaskSourceId,
} from './github-native-task';
import type { GitHubNativeTaskPopulation } from './github-native-task';
import { getGitHubHierarchyRepository } from './github-worker-persistence';

export interface GitHubHierarchyObservation {
  childSourceId: string;
  childIdentityEvidence?: ExternalIdentityEvidence;
  parent: GitHubParentMetadata | null;
  parentIdentityEvidence?: ExternalIdentityEvidence;
}

export type GitHubHierarchyObservationResult =
  | { kind: 'not-issue' }
  | { kind: 'incomplete'; reasonCode: string }
  | { kind: 'complete'; observation: GitHubHierarchyObservation };

export interface GitHubHierarchyReconciliationResult {
  applied: boolean;
  updated: number;
}

export interface GitHubHierarchyReconciliationOptions {
  identityRuntime?: GitHubStableIdentityRuntime;
  requireCompletePopulation?: boolean;
}

function isGitHubParentMetadata(value: unknown): value is GitHubParentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parent = value as Record<string, unknown>;
  return typeof parent.sourceId === 'string'
    && parent.sourceId.length > 0
    && typeof parent.repository === 'string'
    && parent.repository.length > 0
    && typeof parent.issueNumber === 'number'
    && Number.isSafeInteger(parent.issueNumber)
    && parent.issueNumber > 0
    && typeof parent.nodeId === 'string'
    && parent.nodeId.length > 0
    && typeof parent.title === 'string'
    && typeof parent.url === 'string';
}

export function readGitHubHierarchyObservation(
  task: TaskItem,
  expectedConnectorInstanceId?: string,
): GitHubHierarchyObservationResult {
  if (
    task.connectorType !== 'github-issues'
    || !isConnectorNativeTask(task, 'github-issues', expectedConnectorInstanceId)
  ) {
    return { kind: 'not-issue' };
  }
  if (!Object.prototype.hasOwnProperty.call(task.metadata, 'githubParent')) {
    return {
      kind: 'incomplete',
      reasonCode: 'sub_issue_graphql_evidence_unavailable',
    };
  }

  const parent = task.metadata.githubParent;
  if (parent !== null && !isGitHubParentMetadata(parent)) {
    return {
      kind: 'incomplete',
      reasonCode: 'sub_issue_parent_metadata_incomplete',
    };
  }
  return {
    kind: 'complete',
    observation: {
      childSourceId: task.sourceId,
      childIdentityEvidence: task.externalIdentity,
      parent,
      parentIdentityEvidence: parent ? task.githubParentIdentity : undefined,
    },
  };
}

export function mergeGitHubHierarchyObservation(
  observations: Map<string, GitHubHierarchyObservation>,
  incoming: GitHubHierarchyObservation,
): boolean {
  const existing = observations.get(incoming.childSourceId);
  if (!existing) {
    observations.set(incoming.childSourceId, incoming);
    return true;
  }
  if (hierarchyObservationKey(existing) !== hierarchyObservationKey(incoming)) {
    return false;
  }
  return true;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function reconcileGitHubTaskHierarchy(
  connectorInstanceId: string,
  observations: ReadonlyMap<
    string,
    GitHubHierarchyObservation | GitHubParentMetadata | null
  >,
  configuredRepositories: ReadonlySet<string>,
  generationComplete: boolean,
  repositoryAliases: ReadonlyMap<string, string> = new Map(),
  options: GitHubHierarchyReconciliationOptions = {},
): Promise<GitHubHierarchyReconciliationResult> {
  const identityRuntime = options.identityRuntime;
  const repository = await getGitHubHierarchyRepository();
  const normalizedObservations = normalizeHierarchyObservations(
    observations,
    repositoryAliases,
  );
  const configured = configuredGitHubRepositories(
    configuredRepositories,
    repositoryAliases,
  );

  const frozenIdentityContext = identityRuntime?.modeSnapshot;
  if (
    frozenIdentityContext
    && !hierarchyIdentityContextMatches(
      frozenIdentityContext,
      await repository.getIdentityModeSnapshot(connectorInstanceId),
    )
  ) {
    identityRuntime.markBlocked('sub_issue_identity_context_changed');
    return { applied: false, updated: 0 };
  }
  const localTasksBeforeApply = await repository.listConnectorTaskIdentities(connectorInstanceId);
  const stableBindings = await repository.listTaskStableBindings(connectorInstanceId);
  const nativeTasks = localTasksBeforeApply.filter((task) =>
    isConnectorNativeTask(task, 'github-issues', connectorInstanceId));
  const provisionalPopulation = buildGitHubNativeTaskPopulation(
    nativeTasks,
    connectorInstanceId,
    repositoryAliases,
  );
  const provisionalLocalIdentityBySource = buildLocalIdentityBySource(
    nativeTasks,
    repositoryAliases,
  );
  const provisionalTaskIdByStableIdentity = buildPopulationTaskIdByStableIdentity(
    stableBindings,
    provisionalPopulation,
  );
  const observedEndpointTaskIds = observedHierarchyEndpointTaskIds(
    normalizedObservations,
    provisionalLocalIdentityBySource,
    provisionalTaskIdByStableIdentity,
  );
  // A complete stream covers configured repositories plus renamed endpoints
  // resolved by stable identity; accepted terminal absences have no endpoint.
  const scopedNativeTasks = nativeTasks.filter((task) =>
    taskRepositoryIsConfigured(task.sourceId, configured, repositoryAliases)
    || observedEndpointTaskIds.has(task.id));
  const acceptedTerminalTaskIds = latestAcceptedTerminalTaskIds(
    await repository.listTerminalInaccessibleExceptions(connectorInstanceId),
  );
  const supersededHistoricalTaskIds = new Set(
    await repository.provenSupersededTaskIds(
      connectorInstanceId,
      [...observedEndpointTaskIds],
    ),
  );
  const eligibleLocalTasks = scopedNativeTasks.filter((task) =>
    !supersededHistoricalTaskIds.has(task.id)
    && (!acceptedTerminalTaskIds.has(task.id) || observedEndpointTaskIds.has(task.id)));
  const population = buildGitHubNativeTaskPopulation(
    eligibleLocalTasks,
    connectorInstanceId,
    repositoryAliases,
  );
  const localIdentityBySource = buildLocalIdentityBySource(
    eligibleLocalTasks,
    repositoryAliases,
  );
  const populationTaskIdByStableIdentity = buildPopulationTaskIdByStableIdentity(
    stableBindings,
    population,
  );
  const populationObservations = new Map(
    [...normalizedObservations].filter(([, observation]) =>
      endpointIsInPopulation(
        observation.childSourceId,
        observation.childIdentityEvidence,
        localIdentityBySource,
        populationTaskIdByStableIdentity,
      )),
  );
  let hierarchyIdentityDecisions = new Map<string, GitHubIdentityResolutionDecision>();
  if (identityRuntime && generationComplete) {
    hierarchyIdentityDecisions = await resolveGitHubHierarchyIdentity(
      identityRuntime,
      populationObservations,
      configuredRepositories,
      repositoryAliases,
      localIdentityBySource,
      populationTaskIdByStableIdentity,
      new Set(population.memberByTaskId.keys()),
    );
    await identityRuntime.assertDecisionsCurrent(hierarchyIdentityDecisions.values());
  }
  const observedTaskIds = new Set<string>();
  let populationComplete = true;
  for (const observation of populationObservations.values()) {
    const childDecision = hierarchyIdentityDecisions.get(
      `sub_issue:${observation.childSourceId}:child`,
    );
    // NodeID resolution alone selects the child. When identity is unresolved the
    // generation is incomplete, so the hierarchy is left untouched rather than
    // reconciled from the mutable locator.
    const child = identityRuntime
      ? (
          childDecision?.appliedSource === 'stable' && childDecision.selectedLocalId
            ? population.memberByTaskId.get(childDecision.selectedLocalId)
            : undefined
        )
      : population.memberBySourceId.get(observation.childSourceId);
    if (!child) {
      populationComplete = false;
    } else {
      observedTaskIds.add(child.localTaskId);
    }
  }
  const observedPopulationMembers = population.members
    .filter((member) => observedTaskIds.has(member.localTaskId))
    .map((member) => member.memberDigest);
  const observedPopulationDigest = digestGitHubTaskPopulationMembers(observedPopulationMembers);
  populationComplete = populationComplete
    && observedTaskIds.size === populationObservations.size
    && observedTaskIds.size === population.count
    && observedPopulationDigest === population.digest;
  if (!populationComplete && options.requireCompletePopulation) {
    identityRuntime?.markBlocked('sub_issue_population_incomplete');
  }
  if (!generationComplete || !populationComplete || populationObservations.size === 0) {
    return { applied: false, updated: 0 };
  }
  const relevantIdentityFingerprint = hierarchyIdentityFingerprint(
    populationObservations,
    localIdentityBySource,
  );

  const result = await repository.applyReconciliation({
    connectorInstanceId,
    observedEndpointTaskIds: [...observedEndpointTaskIds],
    reconcile: (context) => {
      if (
        frozenIdentityContext
        && !hierarchyIdentityContextMatches(frozenIdentityContext, context.identitySnapshot)
      ) {
        return { fenced: true };
      }
      const localTasks = context.tasks;
      const currentAcceptedTerminalTaskIds = latestAcceptedTerminalTaskIds(
        context.exceptionEvents,
      );
      const currentSupersededHistoricalTaskIds = context.supersededHistoricalTaskIds;
      const eligibleTasks = localTasks.filter((task) =>
        isConnectorNativeTask(task, 'github-issues', connectorInstanceId)
        && (
          taskRepositoryIsConfigured(task.sourceId, configured, repositoryAliases)
          || observedEndpointTaskIds.has(task.id)
        )
        && (
          !currentAcceptedTerminalTaskIds.has(task.id)
          || observedEndpointTaskIds.has(task.id)
        )
        && !currentSupersededHistoricalTaskIds.has(task.id));
      const currentPopulation = buildGitHubNativeTaskPopulation(
        eligibleTasks,
        connectorInstanceId,
        repositoryAliases,
      );
      if (
        currentPopulation.count !== population.count
        || currentPopulation.digest !== population.digest
      ) {
        return { fenced: true };
      }
      const bySourceId = buildLocalIdentityBySource(eligibleTasks, repositoryAliases);
      if (
        relevantIdentityFingerprint
        !== hierarchyIdentityFingerprint(populationObservations, bySourceId)
      ) {
        return { fenced: true };
      }
      const byId = new Map<string, GitHubHierarchyTaskRow>(
        eligibleTasks.map((task) => [task.id, task]),
      );
      const desiredParentByChildId = new Map<string, string | null>();
      const observationByChildId = new Map<string, GitHubParentMetadata | null>();

      for (const observation of populationObservations.values()) {
        const { childSourceId, parent } = observation;
        const stableMode = Boolean(frozenIdentityContext);
        const childDecision = hierarchyIdentityDecisions.get(
          `sub_issue:${observation.childSourceId}:child`,
        );
        const child = stableMode
          ? (
              childDecision?.appliedSource === 'stable' && childDecision.selectedLocalId
                ? byId.get(childDecision.selectedLocalId)
                : undefined
            )
          : bySourceId.get(childSourceId.toLowerCase());
        if (!child) continue;

        const parentDecision = parent
          ? hierarchyIdentityDecisions.get(`sub_issue:${observation.childSourceId}:parent`)
          : undefined;
        const parentTask = parent && configured.has(parent.repository.toLowerCase())
          ? (
              stableMode
                ? (
                    parentDecision?.appliedSource === 'stable'
                      && parentDecision.selectedLocalId
                      ? byId.get(parentDecision.selectedLocalId)
                      : undefined
                  )
                : bySourceId.get(parent.sourceId.toLowerCase())
            )
          : undefined;
        const knownGoodParentId = child.parentId && byId.has(child.parentId)
          ? child.parentId
          : null;
        desiredParentByChildId.set(
          child.id,
          parent === null
            ? null
            : parentTask && parentTask.id !== child.id
              ? parentTask.id
              : knownGoodParentId,
        );
        observationByChildId.set(child.id, parent);
      }

      for (const childId of desiredParentByChildId.keys()) {
        const visited = new Set([childId]);
        let ancestorId = desiredParentByChildId.get(childId) ?? null;
        while (ancestorId) {
          if (visited.has(ancestorId)) {
            desiredParentByChildId.set(childId, null);
            break;
          }
          visited.add(ancestorId);
          const ancestor = byId.get(ancestorId);
          ancestorId = desiredParentByChildId.has(ancestorId)
            ? desiredParentByChildId.get(ancestorId) ?? null
            : ancestor?.parentId ?? null;
        }
      }

      const affectedTaskIds = new Set(desiredParentByChildId.keys());
      let foundDescendant = true;
      while (foundDescendant) {
        foundDescendant = false;
        for (const task of eligibleTasks) {
          if (affectedTaskIds.has(task.id)) continue;
          const parentId = desiredParentByChildId.has(task.id)
            ? desiredParentByChildId.get(task.id) ?? null
            : task.parentId;
          if (parentId && affectedTaskIds.has(parentId)) {
            affectedTaskIds.add(task.id);
            foundDescendant = true;
          }
        }
      }

      const depthCache = new Map<string, number>();
      const resolveDepth = (taskId: string, visiting = new Set<string>()): number => {
        const cached = depthCache.get(taskId);
        if (cached !== undefined) return cached;
        if (visiting.has(taskId)) return 0;
        const task = byId.get(taskId);
        if (!task) return 0;

        const nextVisiting = new Set(visiting).add(taskId);
        const parentId = desiredParentByChildId.has(taskId)
          ? desiredParentByChildId.get(taskId) ?? null
          : task.parentId;
        const depth = parentId ? resolveDepth(parentId, nextVisiting) + 1 : 0;
        depthCache.set(taskId, depth);
        return depth;
      };

      const updates: GitHubHierarchyTaskUpdate[] = [];
      for (const childId of affectedTaskIds) {
        const child = byId.get(childId);
        if (!child) continue;
        const parentId = desiredParentByChildId.has(childId)
          ? desiredParentByChildId.get(childId) ?? null
          : child.parentId;
        const observed = observationByChildId.has(childId);
        const parent = observed ? observationByChildId.get(childId) ?? null : undefined;
        const existingMetadata = parseMetadata(child.metadata);
        const metadataChanged = observed
          && JSON.stringify(existingMetadata.githubParent) !== JSON.stringify(parent);
        const depth = resolveDepth(childId);
        if (
          child.parentId === parentId
          && child.depth === depth
          && !metadataChanged
        ) {
          continue;
        }
        const update: GitHubHierarchyTaskUpdate = { taskId: childId, parentId, depth };
        if (metadataChanged) {
          update.metadata = { ...existingMetadata, githubParent: parent };
        }
        updates.push(update);
      }

      return { fenced: false, updates };
    },
  });
  if (result.fenced) {
    identityRuntime?.markBlocked('sub_issue_apply_context_changed');
  }
  return { applied: result.applied, updated: result.updated };
}

function normalizeHierarchyObservations(
  observations: ReadonlyMap<
    string,
    GitHubHierarchyObservation | GitHubParentMetadata | null
  >,
  repositoryAliases: ReadonlyMap<string, string>,
): Map<string, GitHubHierarchyObservation> {
  return new Map([...observations].map(([childSourceId, value]) => {
    const observation = value && 'childSourceId' in value
      ? value
      : { childSourceId, parent: value };
    const canonicalChildSourceId = canonicalizeGitHubSourceId(
      observation.childSourceId,
      repositoryAliases,
    );
    return [canonicalChildSourceId, {
      ...observation,
      childSourceId: canonicalChildSourceId,
      parent: observation.parent
        ? {
            ...observation.parent,
            sourceId: canonicalizeGitHubSourceId(
              observation.parent.sourceId,
              repositoryAliases,
            ),
          }
        : null,
    }];
  }));
}

function buildLocalIdentityBySource<T extends GitHubHierarchyTaskIdentityRow>(
  localTasks: readonly T[],
  repositoryAliases: ReadonlyMap<string, string>,
): Map<string, T> {
  const bySourceId = new Map(
    localTasks.map((task) => [
      canonicalizeGitHubSourceId(task.sourceId, repositoryAliases),
      task,
    ] as const),
  );
  return bySourceId;
}

function buildPopulationTaskIdByStableIdentity(
  stableBindings: readonly GitHubHierarchyStableBindingRow[],
  population: GitHubNativeTaskPopulation,
): Map<string, string> {
  return new Map(stableBindings
    .filter((row) => population.memberByTaskId.has(row.localTaskId))
    .map((row) => [
      stableIdentityLookupKey(row.provider, row.hostKey, row.entityType, row.stableId),
      row.localTaskId,
    ]));
}

function endpointIsInPopulation(
  sourceId: string,
  evidence: ExternalIdentityEvidence | undefined,
  localBySourceId: ReadonlyMap<string, GitHubHierarchyTaskIdentityRow>,
  populationTaskIdByStableIdentity: ReadonlyMap<string, string>,
): boolean {
  return localBySourceId.has(sourceId.toLowerCase())
    || (
      isGitHubIssueEvidence(evidence)
      && populationTaskIdByStableIdentity.has(stableEvidenceLookupKey(evidence))
    );
}

function observedHierarchyEndpointTaskIds(
  observations: ReadonlyMap<string, GitHubHierarchyObservation>,
  localBySourceId: ReadonlyMap<string, GitHubHierarchyTaskIdentityRow>,
  taskIdByStableIdentity: ReadonlyMap<string, string>,
): Set<string> {
  const observedTaskIds = new Set<string>();
  for (const observation of observations.values()) {
      const local = localBySourceId.get(observation.childSourceId.toLowerCase());
      if (local) observedTaskIds.add(local.id);
      if (isGitHubIssueEvidence(observation.childIdentityEvidence)) {
        const stableTaskId = taskIdByStableIdentity.get(
          stableEvidenceLookupKey(observation.childIdentityEvidence),
        );
        if (stableTaskId) observedTaskIds.add(stableTaskId);
      }
  }
  return observedTaskIds;
}

function latestAcceptedTerminalTaskIds(
  rows: readonly GitHubHierarchyExceptionEventRow[],
): Set<string> {
  const latestActionByTaskId = new Map<string, 'accept' | 'revoke'>();
  for (const row of rows) {
      if (!latestActionByTaskId.has(row.localId)) {
        latestActionByTaskId.set(row.localId, row.action);
      }
  }
  return new Set(
      [...latestActionByTaskId]
        .filter(([, action]) => action === 'accept')
        .map(([localId]) => localId),
  );
}

function taskRepositoryIsConfigured(
  sourceId: string,
  configuredRepositories: ReadonlySet<string>,
  repositoryAliases: ReadonlyMap<string, string>,
): boolean {
  const canonicalSourceId = canonicalizeGitHubSourceId(sourceId, repositoryAliases);
  const source = parseNativeGitHubTaskSourceId(canonicalSourceId);
  return Boolean(source && configuredRepositories.has(source.repository));
}

function hierarchyIdentityContextMatches(
  frozen: { connectorInstanceId: string; modeRevision: number },
  current: { connectorInstanceId: string; modeRevision: number },
): boolean {
  return frozen.connectorInstanceId === current.connectorInstanceId
    && frozen.modeRevision === current.modeRevision;
}

async function resolveGitHubHierarchyIdentity(
  runtime: GitHubStableIdentityRuntime,
  observations: ReadonlyMap<string, GitHubHierarchyObservation>,
  configuredRepositories: ReadonlySet<string>,
  repositoryAliases: ReadonlyMap<string, string>,
  localBySourceId: ReadonlyMap<string, GitHubHierarchyTaskIdentityRow>,
  populationTaskIdByStableIdentity: ReadonlyMap<string, string>,
  populationTaskIds: ReadonlySet<string>,
): Promise<Map<string, GitHubIdentityResolutionDecision>> {
  const configured = configuredGitHubRepositories(
    configuredRepositories,
    repositoryAliases,
  );
  const candidates: GitHubStableIdentityCandidate[] = [];
  for (const observation of [...observations.values()].sort((left, right) =>
    left.childSourceId.localeCompare(right.childSourceId))) {
    const child = localBySourceId.get(observation.childSourceId.toLowerCase());
    const parent = observation.parent
      ? localBySourceId.get(observation.parent.sourceId.toLowerCase())
      : undefined;
    const parentConfigured = observation.parent
      ? configured.has(observation.parent.repository.toLowerCase())
      : true;
    const parentInPopulation = observation.parent
      ? endpointIsInPopulation(
          observation.parent.sourceId,
          observation.parentIdentityEvidence,
          localBySourceId,
          populationTaskIdByStableIdentity,
        )
      : false;
    if (!isGitHubIssueEvidence(observation.childIdentityEvidence)) {
      runtime.markBlocked('sub_issue_child_identity_missing');
    }
    if (
      parentInPopulation
      && parentConfigured
      && !isGitHubIssueEvidence(observation.parentIdentityEvidence)
    ) {
      runtime.markBlocked('sub_issue_parent_identity_missing');
    }
    candidates.push({
        candidateKey: `sub_issue:${observation.childSourceId}:child`,
        locatorMatchedLocalIds: child ? [child.id] : [],
        boundAction: 'present' as const,
        unboundAction: 'none' as const,
        applicableStableLocalIds: populationTaskIds,
        evidence: isGitHubIssueEvidence(observation.childIdentityEvidence)
          ? observation.childIdentityEvidence
          : undefined,
        localTaskId: child?.id,
      });
    if (observation.parent && parentInPopulation && parentConfigured) {
      candidates.push({
        candidateKey: `sub_issue:${observation.childSourceId}:parent`,
        locatorMatchedLocalIds: parent ? [parent.id] : [],
        boundAction: 'present' as const,
        unboundAction: 'none' as const,
        applicableStableLocalIds: populationTaskIds,
        evidence: isGitHubIssueEvidence(observation.parentIdentityEvidence)
          ? observation.parentIdentityEvidence
          : undefined,
        localTaskId: parent?.id,
      });
    }
  }
  const decisions = await runtime.resolveDeduplicatedBatch('sub_issue', 'task', candidates);
  if (decisions.some((decision) =>
    decision.candidateKey.endsWith(':child') && !decision.selectedLocalId)) {
    runtime.markBlocked('sub_issue_child_unresolved');
  }
  if (decisions.some((decision) =>
    decision.candidateKey.endsWith(':parent') && !decision.selectedLocalId)) {
    runtime.markBlocked('sub_issue_parent_unresolved');
  }
  if (decisions.some((decision) => decision.appliedSource !== 'stable')) {
    runtime.markBlocked('sub_issue_identity_resolution_blocked');
  }
  return new Map(decisions.map((decision) => [decision.candidateKey, decision]));
}

function configuredGitHubRepositories(
  configuredRepositories: ReadonlySet<string>,
  repositoryAliases: ReadonlyMap<string, string>,
): Set<string> {
  const configured = new Set(
    [...configuredRepositories].map((repository) => repository.toLowerCase()),
  );
  for (const canonicalRepository of repositoryAliases.values()) {
    configured.add(canonicalRepository.toLowerCase());
  }
  return configured;
}

function isGitHubIssueEvidence(
  evidence: ExternalIdentityEvidence | undefined,
): evidence is ExternalIdentityEvidence {
  if (!evidence?.repository) return false;
  return evidence.repository.identity.provider === 'github'
    && evidence.repository.identity.entityType === 'repository'
    && evidence.repository.identity.stableId.length > 0
    && evidence.entity.identity.provider === 'github'
    && evidence.entity.identity.entityType === 'issue'
    && evidence.entity.identity.stableId.length > 0
    && evidence.entity.identity.hostKey === evidence.repository.identity.hostKey
    && evidence.entity.locator.owner.length > 0
    && evidence.entity.locator.repository.length > 0
    && Number.isSafeInteger(evidence.entity.locator.issueNumber)
    && (evidence.entity.locator.issueNumber ?? 0) > 0;
}

function stableEvidenceLookupKey(evidence: ExternalIdentityEvidence): string {
  return stableIdentityLookupKey(
    evidence.entity.identity.provider,
    evidence.entity.identity.hostKey,
    evidence.entity.identity.entityType,
    evidence.entity.identity.stableId,
  );
}

function stableIdentityLookupKey(
  provider: string,
  hostKey: string,
  entityType: string,
  stableId: string,
): string {
  return JSON.stringify([provider, hostKey, entityType, stableId]);
}

function hierarchyObservationKey(observation: GitHubHierarchyObservation): string {
  return JSON.stringify([
    observation.childSourceId.toLowerCase(),
    observation.parent
      ? [
          observation.parent.sourceId.toLowerCase(),
          observation.parent.repository.toLowerCase(),
          observation.parent.issueNumber,
          observation.parent.nodeId,
        ]
      : null,
    stableEvidenceIdentityKey(observation.childIdentityEvidence),
    stableEvidenceIdentityKey(observation.parentIdentityEvidence),
  ]);
}

function stableEvidenceIdentityKey(
  evidence: ExternalIdentityEvidence | undefined,
): unknown {
  if (!evidence) return null;
  return [
    evidence.entity.identity.hostKey,
    evidence.entity.identity.stableId,
    evidence.entity.locator.owner.toLowerCase(),
    evidence.entity.locator.repository.toLowerCase(),
    evidence.entity.locator.issueNumber ?? null,
  ];
}

function hierarchyIdentityFingerprint(
  observations: ReadonlyMap<string, GitHubHierarchyObservation>,
  localBySourceId: ReadonlyMap<string, GitHubHierarchyTaskIdentityRow>,
): string {
  const endpoints = new Set<string>();
  for (const observation of observations.values()) {
    endpoints.add(observation.childSourceId.toLowerCase());
    if (observation.parent) endpoints.add(observation.parent.sourceId.toLowerCase());
  }
  return JSON.stringify([...endpoints].sort().map((sourceId) => [
    sourceId,
    localBySourceId.get(sourceId)?.id ?? null,
  ]));
}
