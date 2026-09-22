import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  focusItems,
  externalEntities,
  externalEntityBindings,
  externalEntityLocators,
  myDayExclusions,
  myDayItems,
  notifications,
  prioritySyncLog,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  quickSortLog,
  quickSortOperations,
  syncDeletionCandidates,
  syncDeletionSnapshots,
  taskAttachments,
  taskDependencies,
  taskLinkedSources,
  taskLinkedSourceEntities,
  taskProjects,
  taskSchedules,
  taskSourceWriteLeases,
  tasks,
  taskTags,
  weeklyOneThing,
} from '@/db/schema';
import { detachTaskDescendants } from '@/lib/tasks/task-hierarchy-deletion';
import {
  getGitHubIdentityModeSnapshotInTransaction,
  type ExternalIdentityTransaction,
} from '@/lib/external-identities';

export type RestoreMode = 'local' | 'source';
export interface GitHubDeletionFence {
  identityMode: 'legacy' | 'comparison' | 'stable';
  identityModeRevision: number;
  issueEntityId: string | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  locatorRevision: number | null;
  bindingState: string | null;
  bindingRevision: string | null;
  sourceId: string;
}
export interface GitHubRecoveryPreflight {
  (route: {
    targets: ReadonlyArray<{
      role: string;
      owner: string;
      repository: string;
      issueNumber: number | null;
    }>;
  }): Promise<{
    targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
  }>;
}

interface DeletionRelationships {
  tagIds: string[];
  projectIds: string[];
  schedule: typeof taskSchedules.$inferSelect | null;
  dependencies: Array<typeof taskDependencies.$inferSelect>;
  linkedSources: Array<typeof taskLinkedSources.$inferSelect>;
  linkedSourceEntities: Array<typeof taskLinkedSourceEntities.$inferSelect>;
  attachments: Array<typeof taskAttachments.$inferSelect>;
  phaseItems: Array<typeof projectPhaseItems.$inferSelect>;
}

function parseRelationships(value: unknown): DeletionRelationships {
  let parsed = value;
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  const data = parsed && typeof parsed === 'object' ? parsed as Partial<DeletionRelationships> : {};
  return {
    tagIds: Array.isArray(data.tagIds) ? data.tagIds : [],
    projectIds: Array.isArray(data.projectIds) ? data.projectIds : [],
    schedule: data.schedule ?? null,
    dependencies: Array.isArray(data.dependencies) ? data.dependencies : [],
    linkedSources: Array.isArray(data.linkedSources) ? data.linkedSources : [],
    linkedSourceEntities: Array.isArray(data.linkedSourceEntities) ? data.linkedSourceEntities : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    phaseItems: Array.isArray(data.phaseItems) ? data.phaseItems : [],
  };
}

export async function archiveAndDeleteTask(
  taskId: string,
  reason: string,
  expectedGitHubFence?: GitHubDeletionFence,
): Promise<{ snapshotId: string; taskTitle: string; sourceId: string } | null> {
  return runTransaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).get();
    if (!task) return null;
    if (expectedGitHubFence) {
      if (
        task.connectorType !== 'github-issues'
        || task.sourceId !== expectedGitHubFence.sourceId
      ) return null;
      const currentFence = captureGitHubFence(
        tx,
        task.connectorInstanceId,
        task.id,
      );
      if (!sameGitHubDeletionFence(currentFence, expectedGitHubFence)) return null;
    }

    const tagRows = tx.select().from(taskTags).where(eq(taskTags.taskId, taskId)).all();
    const projectRows = tx.select().from(taskProjects).where(eq(taskProjects.taskId, taskId)).all();
    const schedule = tx.select().from(taskSchedules).where(eq(taskSchedules.taskId, taskId)).limit(1).get() ?? null;
    const dependencies = tx.select().from(taskDependencies).where(or(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, taskId),
    )).all();
    const linkedSources = tx.select().from(taskLinkedSources).where(eq(taskLinkedSources.taskId, taskId)).all();
    const linkedSourceEntities = linkedSources.length === 0
      ? []
      : tx.select().from(taskLinkedSourceEntities).where(inArray(
          taskLinkedSourceEntities.linkedSourceId,
          linkedSources.map((linkedSource) => linkedSource.id),
        )).all();
    const attachments = tx.select().from(taskAttachments).where(eq(taskAttachments.taskId, taskId)).all();
    const phaseItems = tx.select().from(projectPhaseItems).where(eq(projectPhaseItems.taskId, taskId)).all();
    const snapshotId = randomUUID();
    const deletedAt = new Date().toISOString();
    const relationshipData: DeletionRelationships = {
      tagIds: tagRows.map(row => row.tagId),
      projectIds: projectRows.map(row => row.projectId),
      schedule,
      dependencies,
      linkedSources,
      linkedSourceEntities,
      attachments,
      phaseItems,
    };
    const githubFence = task.connectorType === 'github-issues'
      ? captureGitHubFence(tx, task.connectorInstanceId, task.id)
      : null;

    tx.insert(syncDeletionSnapshots).values({
      id: snapshotId,
      originalTaskId: task.id,
      connectorId: task.connectorInstanceId,
      sourceId: task.sourceId,
      taskTitle: task.title,
      reason,
      taskData: task,
      relationshipData: { ...relationshipData },
      deletedAt,
      ...(githubFence ?? {}),
    }).run();
    tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
    tx.delete(projectAutoIncludeExclusions)
      .where(eq(projectAutoIncludeExclusions.taskId, taskId))
      .run();
    tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId)).run();
    tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
    tx.delete(myDayItems).where(eq(myDayItems.taskId, taskId)).run();
    tx.delete(myDayExclusions).where(eq(myDayExclusions.taskId, taskId)).run();
    tx.delete(focusItems).where(eq(focusItems.taskId, taskId)).run();
    tx.delete(weeklyOneThing).where(eq(weeklyOneThing.taskId, taskId)).run();
    tx.delete(prioritySyncLog).where(eq(prioritySyncLog.taskId, taskId)).run();
    tx.delete(quickSortLog).where(eq(quickSortLog.taskId, taskId)).run();
    tx.delete(quickSortOperations).where(eq(quickSortOperations.taskId, taskId)).run();
    tx.delete(taskLinkedSources).where(eq(taskLinkedSources.taskId, taskId)).run();
    tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
    tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, taskId)).run();
    tx.delete(taskDependencies).where(or(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, taskId),
    )).run();
    tx.update(notifications).set({ relatedTaskId: null }).where(eq(notifications.relatedTaskId, taskId)).run();
    tx.delete(syncDeletionCandidates).where(eq(syncDeletionCandidates.taskId, taskId)).run();
    detachTaskDescendants(tx, taskId);
    tx.delete(tasks).where(eq(tasks.id, taskId)).run();

    return { snapshotId, taskTitle: task.title, sourceId: task.sourceId };
  });
}

export async function restoreDeletionSnapshot(
  snapshotId: string,
  mode: RestoreMode,
  githubPreflight?: GitHubRecoveryPreflight,
): Promise<{ taskId: string; alreadyRestored: boolean }> {
  const [snapshot] = await db.select()
    .from(syncDeletionSnapshots)
    .where(eq(syncDeletionSnapshots.id, snapshotId))
    .limit(1);
  if (!snapshot) {
    throw new Error('Removed task snapshot not found');
  }
  if (snapshot.restoredTaskId) {
    return { taskId: snapshot.restoredTaskId, alreadyRestored: true };
  }

  const [idConflict] = await db.select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, snapshot.originalTaskId))
    .limit(1);
  if (idConflict) {
    quarantineSnapshot(snapshotId, 'original_task_id_conflict');
    throw new Error('The original Mission Control task ID is occupied');
  }
  const taskId = snapshot.originalTaskId;
  const archivedTask = snapshot.taskData;
  const relationships = parseRelationships(snapshot.relationshipData);
  const now = new Date().toISOString();
  const restoreToSource = mode === 'source';
  if (archivedTask.connectorType === 'github-issues' && isFencedGitHubRecovery(snapshot.identityMode)) {
    const validation = validateGitHubRecoveryFence(db, snapshot);
    if (validation) {
      quarantineSnapshot(snapshotId, validation);
      throw new Error(`GitHub recovery fenced: ${validation}`);
    }
    if (restoreToSource) {
      if (!githubPreflight) {
        quarantineSnapshot(snapshotId, 'missing_remote_identity_preflight');
        throw new Error('GitHub recovery fenced: missing_remote_identity_preflight');
      }
      try {
        const expected = loadGitHubRecoveryPreflight(snapshot);
        const observed = await githubPreflight({ targets: expected.targets });
        if (
          observed.targets.primary_issue?.issueStableId !== expected.issueStableId
          || observed.targets.primary_issue?.repositoryStableId !== expected.repositoryStableId
        ) {
          throw new Error('remote_identity_disagreement');
        }
      } catch (error) {
        const reason = error instanceof Error && error.message === 'remote_identity_disagreement'
          ? error.message
          : 'remote_identity_inaccessible';
        quarantineSnapshot(snapshotId, reason);
        throw new Error(`GitHub recovery fenced: ${reason}`, { cause: error });
      }
    }
  }
  const missingRelationshipCounterpart = relationships.dependencies.some((dependency) => {
    const otherTaskId = dependency.taskId === snapshot.originalTaskId
      ? dependency.dependsOnTaskId
      : dependency.taskId;
    return !db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, otherTaskId)).limit(1).get();
  });
  if (missingRelationshipCounterpart) {
    quarantineSnapshot(snapshotId, 'missing_relationship_counterpart');
    throw new Error('A snapshotted dependency counterpart is unavailable');
  }

  return runTransaction((tx) => {
    if (snapshot.recoveryState === 'quarantined') {
      throw new Error(`Removed task snapshot is quarantined: ${snapshot.quarantineReason ?? 'identity_validation_failed'}`);
    }
    if (archivedTask.connectorType === 'github-issues' && isFencedGitHubRecovery(snapshot.identityMode)) {
      const validation = validateGitHubRecoveryFence(tx, snapshot);
      if (validation) {
        tx.update(syncDeletionSnapshots).set({
          recoveryState: 'quarantined',
          quarantineReason: validation,
          recoveryValidation: 'blocked',
        }).where(eq(syncDeletionSnapshots.id, snapshotId)).run();
        throw new Error(`GitHub recovery fenced: ${validation}`);
      }
    }
    const parent = archivedTask.parentId
      ? tx.select({
        id: tasks.id,
        connectorInstanceId: tasks.connectorInstanceId,
        isChecklistItem: tasks.isChecklistItem,
        sourceId: tasks.sourceId,
      }).from(tasks).where(eq(tasks.id, archivedTask.parentId)).limit(1).get()
      : null;
    const restoreAsSubtask = Boolean(archivedTask.isChecklistItem && archivedTask.parentId && parent);
    if (
      restoreToSource
      && archivedTask.isChecklistItem
      && (
        !restoreAsSubtask
        || parent?.connectorInstanceId !== snapshot.connectorId
        || parent.sourceId.startsWith('local:')
        || (parent.isChecklistItem && parent.sourceId === parent.id)
      )
    ) {
      throw new Error('The original parent task is unavailable');
    }
    const restoredTask: typeof tasks.$inferInsert = {
      ...archivedTask,
      id: taskId,
      sourceId: restoreToSource && restoreAsSubtask ? taskId : `local:${taskId}`,
      connectorType: restoreToSource ? archivedTask.connectorType : 'local',
      connectorInstanceId: restoreToSource ? snapshot.connectorId : 'local',
      sourceListId: restoreToSource ? archivedTask.sourceListId : null,
      sourceListName: restoreToSource ? archivedTask.sourceListName : null,
      isChecklistItem: restoreAsSubtask,
      parentId: restoreAsSubtask ? archivedTask.parentId : null,
      syncStatus: restoreToSource ? 'pending_push' : 'synced',
      pushRetryCount: 0,
      updatedAt: now,
      lastSyncedAt: now,
    };

    const claim = tx.update(syncDeletionSnapshots).set({
      restoreMode: mode,
      recoveryState: 'restoring',
      recoveryClaimToken: randomUUID(),
      recoveryClaimedAt: now,
      recoveryValidation: 'verified',
    }).where(and(
      eq(syncDeletionSnapshots.id, snapshotId),
      isNull(syncDeletionSnapshots.restoredTaskId),
      eq(syncDeletionSnapshots.recoveryState, 'pending'),
    )).run();
    if (claim.changes === 0) {
      const current = tx.select({ restoredTaskId: syncDeletionSnapshots.restoredTaskId })
        .from(syncDeletionSnapshots)
        .where(eq(syncDeletionSnapshots.id, snapshotId))
        .limit(1)
        .get();
      if (!current?.restoredTaskId) {
        throw new Error('Removed task snapshot restore could not be claimed');
      }
      return { taskId: current.restoredTaskId, alreadyRestored: true };
    }

    tx.insert(tasks).values(restoredTask).run();
    if (relationships.tagIds.length > 0) {
      tx.insert(taskTags).values(relationships.tagIds.map(tagId => ({ taskId, tagId }))).run();
    }
    if (relationships.projectIds.length > 0) {
      tx.insert(taskProjects).values(relationships.projectIds.map(projectId => ({ taskId, projectId }))).run();
    }
    if (relationships.schedule) {
      tx.insert(taskSchedules).values({ ...relationships.schedule, taskId }).run();
    }
    if (relationships.linkedSources.length > 0) {
      tx.insert(taskLinkedSources).values(
        relationships.linkedSources.map(row => ({ ...row, taskId })),
      ).run();
      if (relationships.linkedSourceEntities.length > 0) {
        const availableEntityIds = new Set(tx.select({ id: externalEntities.id })
          .from(externalEntities)
          .where(inArray(
            externalEntities.id,
            relationships.linkedSourceEntities.map((row) => row.externalEntityId),
          ))
          .all()
          .map((row) => row.id));
        const occupiedAssociations = new Set(tx.select({
          connectorInstanceId: taskLinkedSourceEntities.connectorInstanceId,
          externalEntityId: taskLinkedSourceEntities.externalEntityId,
        }).from(taskLinkedSourceEntities).where(inArray(
          taskLinkedSourceEntities.externalEntityId,
          relationships.linkedSourceEntities.map((row) => row.externalEntityId),
        )).all().map((row) => (
          linkedSourceEntityKey(row.connectorInstanceId, row.externalEntityId)
        )));
        const restoredLinkedSources = new Map(
          relationships.linkedSources.map((row) => [row.id, row]),
        );
        const restorableAssociations = relationships.linkedSourceEntities.filter(
          (row) => {
            const linkedSource = restoredLinkedSources.get(row.linkedSourceId);
            return availableEntityIds.has(row.externalEntityId)
              && linkedSource?.connectorType === 'github-issues'
              && linkedSource.connectorInstanceId === row.connectorInstanceId
              && !occupiedAssociations.has(linkedSourceEntityKey(
                row.connectorInstanceId,
                row.externalEntityId,
              ));
          },
        );
        if (restorableAssociations.length > 0) {
          tx.insert(taskLinkedSourceEntities).values(restorableAssociations).run();
        }
      }
    }
    if (relationships.attachments.length > 0) {
      tx.insert(taskAttachments).values(
        relationships.attachments.map(row => ({ ...row, id: randomUUID(), taskId })),
      ).run();
    }
    if (relationships.phaseItems.length > 0) {
      tx.insert(projectPhaseItems).values(
        relationships.phaseItems.map(row => ({ ...row, id: randomUUID(), taskId })),
      ).run();
    }

    const restorableDependencies = relationships.dependencies.filter(row => (
      row.taskId === snapshot.originalTaskId || row.dependsOnTaskId === snapshot.originalTaskId
    ));
    for (const dependency of restorableDependencies) {
      const restoredDependency = {
        ...dependency,
        id: randomUUID(),
        taskId: dependency.taskId === snapshot.originalTaskId ? taskId : dependency.taskId,
        dependsOnTaskId: dependency.dependsOnTaskId === snapshot.originalTaskId
          ? taskId
          : dependency.dependsOnTaskId,
      };
      const otherTaskId = restoredDependency.taskId === taskId
        ? restoredDependency.dependsOnTaskId
        : restoredDependency.taskId;
      const otherExists = tx.select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, otherTaskId))
        .limit(1)
        .get();
      if (!otherExists) throw new Error('A snapshotted dependency counterpart is unavailable');
      tx.insert(taskDependencies).values(restoredDependency).run();
    }

    tx.update(syncDeletionSnapshots).set({
      recoveryState: 'restored',
      restoredAt: now,
      restoredTaskId: taskId,
      recoveryClaimToken: null,
      recoveryValidation: 'restored_original_task_id',
    }).where(eq(syncDeletionSnapshots.id, snapshotId)).run();

    return { taskId, alreadyRestored: false };
  });
}

function linkedSourceEntityKey(connectorInstanceId: string, externalEntityId: string): string {
  return `${connectorInstanceId.length}:${connectorInstanceId}${externalEntityId}`;
}

function loadGitHubRecoveryPreflight(
  snapshot: typeof syncDeletionSnapshots.$inferSelect,
): {
  targets: ReadonlyArray<{
    role: 'primary_issue';
    owner: string;
    repository: string;
    issueNumber: number;
  }>;
  issueStableId: string;
  repositoryStableId: string;
} {
  const row = db.select({
    owner: externalEntityLocators.owner,
    repository: externalEntityLocators.repository,
    issueNumber: externalEntityLocators.issueNumber,
    issueStableId: externalEntities.stableId,
  }).from(externalEntityLocators)
    .innerJoin(externalEntities, eq(externalEntities.id, externalEntityLocators.externalEntityId))
    .where(and(
      eq(externalEntityLocators.externalEntityId, snapshot.issueEntityId!),
      isNull(externalEntityLocators.validTo),
    ))
    .limit(1)
    .get();
  const repository = db.select({ stableId: externalEntities.stableId })
    .from(externalEntities)
    .where(eq(externalEntities.id, snapshot.repositoryEntityId!))
    .limit(1)
    .get();
  if (!row || !repository || row.issueNumber === null) {
    throw new Error('remote_identity_inaccessible');
  }
  return {
    targets: [{
      role: 'primary_issue',
      owner: row.owner,
      repository: row.repository,
      issueNumber: row.issueNumber,
    }],
    issueStableId: row.issueStableId,
    repositoryStableId: repository.stableId,
  };
}

function captureGitHubFence(
  tx: ExternalIdentityTransaction,
  connectorId: string,
  taskId: string,
): {
  identityMode: 'legacy' | 'comparison' | 'stable';
  identityModeRevision: number;
  issueEntityId: string | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  locatorRevision: number | null;
  bindingState: string | null;
  bindingRevision: string | null;
} {
  const mode = getGitHubIdentityModeSnapshotInTransaction(tx, connectorId);
  const binding = tx.select().from(externalEntityBindings).where(and(
    eq(externalEntityBindings.connectorInstanceId, connectorId),
    eq(externalEntityBindings.bindingType, 'task'),
    eq(externalEntityBindings.localId, taskId),
  )).limit(1).get();
  const entity = binding
    ? tx.select().from(externalEntities).where(eq(externalEntities.id, binding.externalEntityId)).limit(1).get()
    : null;
  const locator = entity
    ? tx.select().from(externalEntityLocators).where(and(
      eq(externalEntityLocators.externalEntityId, entity.id),
      isNull(externalEntityLocators.validTo),
    )).limit(1).get()
    : null;
  return {
    identityMode: mode.effectiveMode,
    identityModeRevision: mode.modeRevision,
    issueEntityId: entity?.id ?? null,
    repositoryEntityId: locator?.repositoryEntityId ?? null,
    hostKey: entity?.hostKey ?? null,
    locatorRevision: locator?.locatorRevision ?? null,
    bindingState: binding?.state ?? null,
    bindingRevision: binding?.verifiedAt ?? null,
  };
}

function sameGitHubDeletionFence(
  current: Omit<GitHubDeletionFence, 'sourceId'>,
  expected: GitHubDeletionFence,
): boolean {
  return current.identityMode === expected.identityMode
    && current.identityModeRevision === expected.identityModeRevision
    && current.issueEntityId === expected.issueEntityId
    && current.repositoryEntityId === expected.repositoryEntityId
    && current.hostKey === expected.hostKey
    && current.locatorRevision === expected.locatorRevision
    && current.bindingState === expected.bindingState
    && current.bindingRevision === expected.bindingRevision;
}

function validateGitHubRecoveryFence(
  tx: ExternalIdentityTransaction,
  snapshot: typeof syncDeletionSnapshots.$inferSelect,
): string | null {
  if (!isFencedGitHubRecovery(snapshot.identityMode)) return null;
  if (!snapshot.issueEntityId || !snapshot.repositoryEntityId || !snapshot.locatorRevision) {
    return 'missing_snapshot_identity';
  }
  const mode = getGitHubIdentityModeSnapshotInTransaction(tx, snapshot.connectorId);
  if (mode.modeRevision !== snapshot.identityModeRevision) return 'stale_mode_revision';
  const binding = tx.select().from(externalEntityBindings).where(and(
    eq(externalEntityBindings.connectorInstanceId, snapshot.connectorId),
    eq(externalEntityBindings.bindingType, 'task'),
    eq(externalEntityBindings.localId, snapshot.originalTaskId),
    eq(externalEntityBindings.externalEntityId, snapshot.issueEntityId),
    inArray(externalEntityBindings.state, ['shadow', 'active']),
  )).limit(1).get();
  if (!binding) return 'missing_or_collision_binding';
  if (snapshot.identityMode === 'stable' && binding.state !== 'active') {
    return 'stable_binding_not_active';
  }
  if (!binding.verifiedAt || binding.verifiedAt !== snapshot.bindingRevision) {
    return 'binding_revision_changed';
  }

  const locator = tx.select().from(externalEntityLocators).where(and(
    eq(externalEntityLocators.externalEntityId, snapshot.issueEntityId),
    isNull(externalEntityLocators.validTo),
  )).limit(1).get();
  if (
    !locator
    || locator.repositoryEntityId !== snapshot.repositoryEntityId
    || locator.locatorRevision !== snapshot.locatorRevision
  ) return 'locator_replaced';
  const activeLease = tx.select({ id: taskSourceWriteLeases.id }).from(taskSourceWriteLeases).where(and(
    eq(taskSourceWriteLeases.connectorInstanceId, snapshot.connectorId),
    eq(taskSourceWriteLeases.taskId, snapshot.originalTaskId),
    inArray(taskSourceWriteLeases.state, ['claimed', 'authorized', 'dispatched', 'unknown']),
  )).limit(1).get();
  return activeLease ? 'active_or_unknown_write_lease' : null;
}

/** Snapshots captured before the permanent cutover may carry historical modes. */
function isFencedGitHubRecovery(mode: string | null): boolean {
  return mode !== null && mode !== 'legacy';
}

function quarantineSnapshot(snapshotId: string, reason: string): void {
  db.update(syncDeletionSnapshots).set({
    recoveryState: 'quarantined',
    quarantineReason: reason,
    recoveryValidation: 'blocked',
  }).where(and(
    eq(syncDeletionSnapshots.id, snapshotId),
    isNull(syncDeletionSnapshots.restoredTaskId),
    inArray(syncDeletionSnapshots.recoveryState, ['pending', 'restoring']),
  )).run();
}
