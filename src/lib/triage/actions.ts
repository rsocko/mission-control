/**
 * Triage actions module — applies and undoes triage swipe/action-bar actions,
 * including idempotent create_task_todo reservation/claim handling. This is
 * the one module that wires up the per-provider action integrations
 * (Karakeep, MS Todo, Model Catalog, Knowledge Base, Document Intelligence),
 * so only consumers that actually execute actions should import from here —
 * query-only or capture-only consumers should use `./query` / `./capture`
 * instead to avoid pulling this wiring into their bundle.
 *
 * Persistence is owned by the composed triage action repository; every remote
 * call, semantic publication, and claim-recovery decision stays here.
 */
import { randomUUID } from 'crypto';
import type { TriageActionRecord, TriageActionType, TriageItem, TriageStatus } from '@/types';
import logger from '@/lib/logger';
import { saveToKarakeep } from './actions/karakeep';
import {
  createTodoTaskFromTriageItem,
  findTodoTaskFromTriageItem,
  TodoTaskCreationError,
} from './actions/ms-todo';
import type { CreateTodoTaskOptions } from './actions/ms-todo';
import { saveToModelCatalog } from './actions/model-catalog';
import type { ModelCatalogOptions } from './actions/model-catalog';
import { saveToKnowledgeBase, buildKnowledgeBaseActionRecord } from './actions/knowledge-base';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication';
import type { KnowledgeBaseOptions } from './actions/knowledge-base';
import {
  completeDocumentAction,
  deferDocumentAction,
  reopenDocumentAction,
} from './actions/document-intelligence';
import { ensureSeedData, safeJsonObject } from './shared';
import { getTriagePersistenceRepositories } from './persistence';

const SNOOZE_DURATION_MS = 1000 * 60 * 60 * 24;
const IDEMPOTENT_ACTIONS = new Set<TriageActionType>(['create_task_todo']);
const CLAIM_SETTLE_ATTEMPTS = 40;
const CLAIM_SETTLE_DELAY_MS = 25;
const CLAIM_RECONCILIATION_GRACE_MS = 5 * 60 * 1000;
const TASK_CREATION_ACTION_TYPE = 'create_task_todo';

function actions() {
  return getTriagePersistenceRepositories().actions;
}

export class TriageActionInProgressError extends Error {
  constructor(readonly triageItemId: string) {
    super('Task creation for this triage item is still in progress');
    this.name = 'TriageActionInProgressError';
  }
}

export type TriageTaskClaim =
  | { kind: 'claimed'; claimId: string; item: TriageItem }
  | { kind: 'completed'; item: TriageItem; record?: TriageActionRecord }
  | {
      kind: 'pending';
      claimId: string;
      claimedAt: string;
      context?: { listId?: string; listName?: string };
      item: TriageItem;
    };

async function readTaskClaim(id: string) {
  return actions().readClaim({
    triageItemId: id,
    actionType: TASK_CREATION_ACTION_TYPE,
  });
}

export async function reserveTriageTaskCreation(id: string): Promise<TriageTaskClaim | null> {
  await ensureSeedData();
  const item = await actions().getActionSnapshot(id);
  if (!item) return null;

  const recorded = item.actionsTaken.find(
    (action) => action.actionType === TASK_CREATION_ACTION_TYPE,
  );
  if (recorded) {
    return { kind: 'completed', item, record: recorded };
  }

  const claimId = randomUUID();
  const { acquired } = await actions().reserveClaim({
    claimId,
    triageItemId: id,
    actionType: TASK_CREATION_ACTION_TYPE,
    claimedAt: new Date().toISOString(),
  });

  if (acquired) {
    return { kind: 'claimed', claimId, item };
  }

  for (let attempt = 0; attempt < CLAIM_SETTLE_ATTEMPTS; attempt++) {
    const claim = await readTaskClaim(id);
    if (claim?.state === 'completed') {
      const current = await actions().getActionSnapshot(id);
      if (!current) return null;
      return {
        kind: 'completed',
        item: current,
        record: claim.result as TriageActionRecord | undefined,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_DELAY_MS));
  }

  const claim = await readTaskClaim(id);
  return claim
    ? {
        kind: 'pending',
        claimId: claim.id,
        claimedAt: claim.claimedAt,
        context: safeJsonObject(claim.result),
        item,
      }
    : reserveTriageTaskCreation(id);
}

export async function completeTriageTaskCreation(
  id: string,
  claimId: string,
  record: TriageActionRecord,
): Promise<TriageItem> {
  const { item } = await actions().completeClaim({
    claimId,
    triageItemId: id,
    record,
    completedAt: new Date().toISOString(),
  });

  if (!item) throw new Error('Triage item disappeared while completing task creation');
  await publishSemanticEntityUpsert('triage-item', id);
  return item;
}

async function heartbeatTriageTaskCreation(claimId: string): Promise<boolean> {
  return actions().heartbeatClaim({
    claimId,
    claimedAt: new Date().toISOString(),
  });
}

async function recordTriageTaskTarget(
  claimId: string,
  target: { listId: string; listName: string },
): Promise<boolean> {
  return actions().recordClaimTarget({
    claimId,
    claimedAt: new Date().toISOString(),
    target,
  });
}

export async function releaseTriageTaskCreation(
  claimId: string,
  expectedClaimedAt?: string,
): Promise<boolean> {
  return actions().releaseClaim({ claimId, expectedClaimedAt });
}

export async function applyTriageAction(
  id: string,
  actionType: TriageActionType,
  note?: string,
  overrides?: { tags?: string[]; list?: string },
  todoOptions?: CreateTodoTaskOptions,
  modelCatalogOptions?: ModelCatalogOptions,
  knowledgeBaseOptions?: KnowledgeBaseOptions,
  options?: { skipExternalAction?: boolean },
  concurrencyAttempt = 0,
) {
  await ensureSeedData();

  const item = await actions().getActionSnapshot(id);
  if (!item) return null;

  if (item.actionsTaken.at(-1)?.metadata?.undoInProgress === true) {
    throw new TriageActionInProgressError(id);
  }

  const skip = options?.skipExternalAction === true;
  let actionClaimId: string | null = null;

  if (IDEMPOTENT_ACTIONS.has(actionType)) {
    const reservation = await reserveTriageTaskCreation(id);
    if (!reservation) return null;
    if (reservation.kind === 'completed') return reservation.item;
    if (reservation.kind === 'pending') {
      if (!skip) {
        const reconciled = await findTodoTaskFromTriageItem(item, {
          ...todoOptions,
          listId: reservation.context?.listId || todoOptions?.listId,
          listName: reservation.context?.listName || todoOptions?.listName,
        });
        if (reconciled) {
          return completeTriageTaskCreation(id, reservation.claimId, {
            actionType,
            appliedAt: new Date().toISOString(),
            note: `Recovered task in "${reconciled.listName}" list`,
            metadata: {
              todoTaskId: reconciled.taskId,
              todoTaskTitle: reconciled.taskTitle,
              todoListId: reconciled.listId,
              todoListName: reconciled.listName,
              todoWebUrl: reconciled.webUrl,
            },
          });
        }
        if (Date.now() - new Date(reservation.claimedAt).getTime() >= CLAIM_RECONCILIATION_GRACE_MS) {
          const released = await releaseTriageTaskCreation(
            reservation.claimId,
            reservation.claimedAt,
          );
          if (released) {
            return applyTriageAction(
              id,
              actionType,
              note,
              overrides,
              todoOptions,
              modelCatalogOptions,
              knowledgeBaseOptions,
              options,
            );
          }
        }
      }
      throw new TriageActionInProgressError(id);
    }
    actionClaimId = reservation.claimId;
  }

  // Execute the Karakeep write-back if this is a save_karakeep action
  let karakeepNote = note;
  if (actionType === 'save_karakeep' && !skip) {
    const result = await saveToKarakeep(item, overrides);
    if (!result.success) {
      throw new Error(result.error || 'Karakeep save failed');
    }
    karakeepNote = karakeepNote
      ? `${karakeepNote} (Karakeep bookmark: ${result.bookmarkId})`
      : `Saved to Karakeep (bookmark: ${result.bookmarkId})`;
  }

  const record: TriageActionRecord = {
    id: randomUUID(),
    actionType,
    appliedAt: new Date().toISOString(),
    note: karakeepNote,
  };
  if (isUndoableTriageAction(actionType)) {
    record.metadata = {
      undoPreviousStatus: item.status,
      undoPreviousSnoozedUntil: item.snoozedUntil ?? null,
    };
  }

  // Execute MS Todo task creation when action is create_task_todo
  // Skip when the task was already created externally (e.g. via AddTaskModal)
  if (actionType === 'create_task_todo' && !skip) {
    try {
      if (actionClaimId && !(await heartbeatTriageTaskCreation(actionClaimId))) {
        throw new TriageActionInProgressError(id);
      }
      const result = await createTodoTaskFromTriageItem(item, {
        ...todoOptions,
        onTargetResolved: async (target) => {
          if (!actionClaimId || !(await recordTriageTaskTarget(actionClaimId, target))) {
            throw new TriageActionInProgressError(id);
          }
        },
      });
      record.metadata = {
        todoTaskId: result.taskId,
        todoTaskTitle: result.taskTitle,
        todoListId: result.listId,
        todoListName: result.listName,
        todoWebUrl: result.webUrl,
      };
      record.note = record.note || `Created in "${result.listName}" list`;
    } catch (err) {
      if (actionClaimId && (!(err instanceof TodoTaskCreationError) || !err.outcomeUnknown)) {
        await releaseTriageTaskCreation(actionClaimId);
      }
      logger.error({ err, triageItemId: id }, 'Failed to create MS Todo task from triage action');
      throw err;
    }
  }

  // Execute Model Catalog save when action is save_model_catalog
  if (actionType === 'save_model_catalog' && !skip) {
    const result = await saveToModelCatalog(item, modelCatalogOptions);
    if (!result.success) {
      throw new Error(result.error || 'Model Catalog save failed');
    }
    record.metadata = { modelCatalogEntryId: result.entryId };
    record.note = record.note
      ? `${record.note} (Model Catalog entry: ${result.entryId})`
      : `Saved to Model Catalog (entry: ${result.entryId})`;
  }

  // Execute Knowledge Base save when action is save_knowledge_base
  if (actionType === 'save_knowledge_base' && !skip) {
    const result = await saveToKnowledgeBase(item, knowledgeBaseOptions);
    if (!result.success) {
      throw new Error(result.error || 'Knowledge Base save failed');
    }
    const kbRecord = buildKnowledgeBaseActionRecord(result);
    record.metadata = kbRecord.metadata;
    record.note = kbRecord.note;
  }

  if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence') {
    record.note = record.note || 'Completed in OWL';
  }

  if (actionType === 'defer_action' && !skip) {
    if (item.sourcePlatform === 'document-intelligence') {
      await deferDocumentAction(item);
    }
    record.note = record.note || 'Deferred';
  }

  const nextStatus: TriageStatus =
    actionType === 'dismiss'
      ? 'dismissed'
      : actionType === 'snooze' || actionType === 'defer_action'
        ? 'snoozed'
        : 'actioned';

  const snoozedUntil =
    actionType === 'snooze' || actionType === 'defer_action'
      ? new Date(Date.now() + SNOOZE_DURATION_MS).toISOString()
      : null;

  if (actionClaimId) {
    return completeTriageTaskCreation(id, actionClaimId, record);
  }

  const fence = isUndoableTriageAction(actionType)
    ? {
        actionsTaken: item.actionsTaken,
        status: item.status,
        snoozedUntil: item.snoozedUntil ?? null,
      }
    : null;
  const updated = await actions().appendAction({
    triageItemId: id,
    status: nextStatus,
    snoozedUntil,
    record,
    fence,
  });
  if (!updated && fence) {
    if (concurrencyAttempt >= 3) {
      throw new TriageActionInProgressError(id);
    }
    return applyTriageAction(
      id,
      actionType,
      note,
      overrides,
      todoOptions,
      modelCatalogOptions,
      knowledgeBaseOptions,
      options,
      concurrencyAttempt + 1,
    );
  }
  if (!updated) return null;

  if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence' && !skip) {
    const result = await completeDocumentAction(item);
    if (!result.success) {
      logger.warn({ triageItemId: id, err: result.error }, 'DI complete_action write-back failed (action recorded locally)');
    }
  }
  await publishSemanticEntityUpsert('triage-item', id);
  return updated;
}

export async function undoTriageAction(
  id: string,
  actionType: TriageActionType,
  actionId: string,
) {
  if (!isUndoableTriageAction(actionType)) return null;
  await ensureSeedData();

  const item = await actions().getActionSnapshot(id);
  if (!item) return null;

  const latestAction = item.actionsTaken.at(-1);
  if (
    latestAction?.id !== actionId
    || latestAction.actionType !== actionType
  ) {
    return null;
  }
  const previousStatus = latestAction.metadata?.undoPreviousStatus;
  const previousSnoozedUntil = latestAction.metadata?.undoPreviousSnoozedUntil;
  if (
    typeof previousStatus !== 'string'
    || !isRestorableTriageStatus(previousStatus)
    || (previousSnoozedUntil !== null && typeof previousSnoozedUntil !== 'string')
  ) {
    return null;
  }
  const undoInProgress = latestAction.metadata?.undoInProgress === true;
  const undoClaimedAt = latestAction.metadata?.undoClaimedAt;
  const claimIsStale = typeof undoClaimedAt !== 'string'
    || Date.now() - new Date(undoClaimedAt).getTime() >= 30_000;
  if (undoInProgress && !claimIsStale) return null;
  const originalMetadata = { ...latestAction.metadata };
  delete originalMetadata.undoInProgress;
  delete originalMetadata.undoClaimId;
  delete originalMetadata.undoClaimedAt;
  const originalAction: TriageActionRecord = {
    ...latestAction,
    metadata: originalMetadata,
  };
  const originalActions = [...item.actionsTaken.slice(0, -1), originalAction];
  let expectedActions: TriageActionRecord[] = item.actionsTaken;
  if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence') {
    const claimedAction: TriageActionRecord = {
      ...originalAction,
      metadata: {
        ...originalMetadata,
        undoInProgress: true,
        undoClaimId: randomUUID(),
        undoClaimedAt: new Date().toISOString(),
      },
    };
    const claimedActions = [...originalActions.slice(0, -1), claimedAction];
    const claim = await actions().casActions({
      triageItemId: id,
      actions: claimedActions,
      expectedActions,
    });
    if (!claim) return null;
    expectedActions = claimedActions;

    try {
      await reopenDocumentAction(item);
    } catch (error) {
      await actions().casActions({
        triageItemId: id,
        actions: originalActions,
        expectedActions,
      });
      throw error;
    }
  }

  const updated = await actions().casActions({
    triageItemId: id,
    actions: item.actionsTaken.slice(0, -1),
    expectedActions,
    status: previousStatus,
    snoozedUntil: previousSnoozedUntil ?? null,
  });

  if (!updated) return null;
  await publishSemanticEntityUpsert('triage-item', id);
  return updated;
}

export function isUndoableTriageAction(actionType: string): actionType is TriageActionType {
  return actionType === 'complete_action' || actionType === 'dismiss' || actionType === 'snooze';
}

function isRestorableTriageStatus(status: string): status is TriageStatus {
  return status === 'pending'
    || status === 'snoozed'
    || status === 'actioned'
    || status === 'dismissed';
}
