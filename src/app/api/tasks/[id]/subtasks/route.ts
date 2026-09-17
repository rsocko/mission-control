import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { logWriteThrough } from '@/lib/sync/write-through-log';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { createBreakdownContextVersion, titleKey } from '@/lib/ai/task-breakdown';
import { isPublicDemoMode } from '@/lib/public-demo';
import { isDemoMode } from '@/lib/mode';
import { resolveTaskFieldPolicy } from '@/lib/tasks/field-policy';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  TaskCoreTaskRow,
  TaskMoveTaskInsert,
  TaskSubtaskProposalSnapshot,
} from '@/lib/tasks/core/contracts';
import type { ConnectorConfig } from '@/types';

const createSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  effort: z.number().int().min(1).max(5).nullable().optional(),
  expectedContextVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposalId: z.string().uuid().optional(),
});

const reorderSubtasksSchema = z.object({
  orderedChildIds: z.array(z.string().min(1)).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Child IDs must be unique'),
  expectedRevision: z.number().int().nonnegative(),
});

async function getOrRefreshSubtaskConnector(connectorInstanceId: string) {
  const registry = getConnectorRegistry();
  const existing = registry.getConnector(connectorInstanceId);
  if (existing) return existing;
  const repositories = await getWorkerPersistenceRepositories();
  const config = await repositories.connectors.get(connectorInstanceId);
  if (!config) return null;
  repositories.execution.support.assertConfigSupported(config);
  const resolvedConfig: ConnectorConfig = {
    ...config,
    syncMode: config.syncMode || 'poll',
    pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
  };
  return registry.replaceConnector(resolvedConfig);
}

function contextVersion(snapshot: TaskSubtaskProposalSnapshot): string {
  return createBreakdownContextVersion({
    updatedAt: snapshot.parentUpdatedAt,
    tags: snapshot.tagNames,
    projects: snapshot.projectNames,
    existingSubtasks: snapshot.subtaskTitles,
  });
}

function proposalReplayResponse(
  task: TaskCoreTaskRow,
  currentContextVersion: string,
) {
  return NextResponse.json({
    subtask: {
      id: task.id,
      title: task.title,
      status: task.status,
      effort: task.effort,
      parentId: task.parentId,
    },
    contextVersion: currentContextVersion,
    duplicate: true,
  });
}

function buildSubtask(
  parent: TaskCoreTaskRow,
  input: {
    id: string;
    title: string;
    effort: number | null;
    now: string;
    syncStatus: string;
  },
): TaskMoveTaskInsert {
  return {
    id: input.id,
    sourceId: input.id,
    connectorType: parent.connectorType,
    connectorInstanceId: parent.connectorInstanceId,
    title: input.title,
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'none',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: parent.id,
    depth: parent.depth + 1,
    isChecklistItem: true,
    sourceListId: parent.sourceListId,
    sourceListName: parent.sourceListName,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: input.syncStatus,
    lastSyncedAt: input.now,
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: input.effort,
    isBulkImport: false,
  };
}

/**
 * GET /api/tasks/[id]/subtasks — List subtasks/checklist items for a task.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const { ancillary } = await getTaskCorePersistence();
    const state = await ancillary.getSubtaskOrderState(id);
    if (!state) {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to list subtasks');
    return NextResponse.json({ error: 'Failed to list subtasks' }, { status: 500 });
  }
}

/**
 * PATCH /api/tasks/[id]/subtasks — Atomically reorder every direct child.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const parsedBody = reorderSubtasksSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid subtask order' }, { status: 400 });
    }

    const { ancillary } = await getTaskCorePersistence();
    const parent = await ancillary.getTask(id);
    if (!parent) {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    }
    const previousState = await ancillary.getSubtaskOrderState(id);
    if (!previousState) {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    }
    const capabilities = parent.connectorType === 'local' || parent.sourceId.startsWith('local:')
      ? null
      : await getConnectorCapabilities(parent.connectorInstanceId);

    const outcome = await ancillary.reorderSubtasks({
      parentTaskId: id,
      orderedChildIds: parsedBody.data.orderedChildIds,
      expectedRevision: parsedBody.data.expectedRevision,
    });
    if (outcome.kind === 'revision-conflict') {
      const current = await ancillary.getSubtaskOrderState(id);
      return NextResponse.json({
        error: 'Subtask order changed in another session',
        revision: outcome.currentRevision,
        subtasks: current?.subtasks ?? [],
      }, { status: 409 });
    }
    if (outcome.kind === 'invalid-children') {
      const current = await ancillary.getSubtaskOrderState(id);
      return NextResponse.json(
        {
          error: 'The submitted order must contain every direct subtask exactly once',
          revision: current?.revision,
          subtasks: current?.subtasks ?? [],
        },
        { status: 422 },
      );
    }
    if (outcome.kind === 'parent-not-found') {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    }

    const shouldWriteThrough =
      capabilities?.write === true && capabilities.subtaskOrderWrite === true;
    if (!shouldWriteThrough) {
      return NextResponse.json({
        revision: outcome.revision,
        writeBack: 'local-only',
      });
    }

    let connector: Awaited<ReturnType<typeof getOrRefreshSubtaskConnector>> = null;
    const previousSourceIds = previousState.subtasks.map((subtask) => subtask.sourceId);
    try {
      connector = await getOrRefreshSubtaskConnector(parent.connectorInstanceId);
      if (!connector?.reorderSubTasks) {
        throw new Error('Connector does not implement subtask ordering');
      }
      const activeConnector = connector;
      const sourceIdByTaskId = new Map(
        previousState.subtasks.map((subtask) => [subtask.id, subtask.sourceId]),
      );
      const orderedSourceIds = parsedBody.data.orderedChildIds.map((taskId) => {
        const sourceId = sourceIdByTaskId.get(taskId);
        if (!sourceId) throw new Error(`Missing source identity for subtask ${taskId}`);
        return sourceId;
      });
      const write = () => activeConnector.reorderSubTasks!(parent.sourceId, orderedSourceIds);
      if (activeConnector.type === 'github-issues') {
        await executeFencedGitHubTaskMutation({
          connectorInstanceId: parent.connectorInstanceId,
          taskId: parent.id,
          operation: 'sub_issue',
          connector: activeConnector,
          write,
        });
      } else {
        await write();
      }
      return NextResponse.json({
        revision: outcome.revision,
        writeBack: 'synced',
      });
    } catch (error) {
      logger.error({ err: error, taskId: id }, 'Subtask reorder write-through failed');
      let sourceCompensated = true;
      if (connector?.type === 'github-issues' && connector.reorderSubTasks) {
        try {
          await executeFencedGitHubTaskMutation({
            connectorInstanceId: parent.connectorInstanceId,
            taskId: parent.id,
            operation: 'sub_issue',
            connector,
            write: () => connector!.reorderSubTasks!(parent.sourceId, previousSourceIds),
          });
        } catch (compensationError) {
          sourceCompensated = false;
          logger.error(
            { err: compensationError, taskId: id },
            'GitHub subtask reorder source compensation failed',
          );
        }
      }
      const rollback = await ancillary.reorderSubtasks({
        parentTaskId: id,
        orderedChildIds: previousState.subtasks.map((subtask) => subtask.id),
        expectedRevision: outcome.revision,
      });
      if (rollback.kind !== 'reordered') {
        const current = await ancillary.getSubtaskOrderState(id);
        logger.error(
          { taskId: id, rollback },
          'Subtask reorder local compensation failed',
        );
        return NextResponse.json(
          {
            error: 'Could not save the new order or restore the previous local order. Refresh to continue.',
            revision: current?.revision,
            subtasks: current?.subtasks,
          },
          { status: 502 },
        );
      }
      return NextResponse.json(
        {
          error: sourceCompensated
            ? 'Could not save the new order to the source. The previous order was restored.'
            : 'The source order could not be verified. The previous local order was restored; refresh after the next sync.',
          revision: rollback.revision,
          subtasks: previousState.subtasks,
        },
        { status: 502 },
      );
    }
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to reorder subtasks');
    return NextResponse.json({ error: 'Failed to reorder subtasks' }, { status: 500 });
  }
}

/**
 * POST /api/tasks/[id]/subtasks — Add a subtask/step to a task.
 * Immediate write-through creates the durable local intent before source I/O.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const parsedBody = createSubtaskSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid subtask data' }, { status: 400 });
    }
    const { title, effort, expectedContextVersion, proposalId } = parsedBody.data;
    const isProposalAcceptance = proposalId !== undefined || expectedContextVersion !== undefined;
    if (isProposalAcceptance && (!proposalId || !expectedContextVersion)) {
      return NextResponse.json({ error: 'Incomplete proposal acceptance data' }, { status: 400 });
    }
    if (isProposalAcceptance && !isTrustedMutationRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ancillary } = await getTaskCorePersistence();
    const parent = await ancillary.getTask(id);
    if (!parent) {
      return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
    }

    const isLocalOnly = parent.sourceId.startsWith('local:') || parent.connectorType === 'local';
    const forceLocal = isPublicDemoMode() || isDemoMode();
    const [capabilities, connectorEnabled] = isLocalOnly || forceLocal
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(parent.connectorInstanceId),
          isConnectorEnabled(parent.connectorInstanceId),
        ]);
    const structurePolicy = resolveTaskFieldPolicy({
      sourceId: parent.sourceId,
      connectorType: parent.connectorType,
      connectorEnabled,
      forceLocal,
    }, capabilities, 'dependencies');
    if (structurePolicy.mutation === 'blocked') {
      return NextResponse.json({
        error: capabilities && !capabilities.write
          ? 'Write is disabled for this connector'
          : structurePolicy.reason ?? 'Subtasks cannot be changed for this task source',
      }, { status: 403 });
    }

    const shouldWriteThrough = structurePolicy.mutation === 'write-through';
    if (shouldWriteThrough) {
      if (capabilities && !capabilities.write) {
        return NextResponse.json({ error: 'Write is disabled for this connector' }, { status: 403 });
      }
      if (capabilities?.subtasks !== true) {
        return NextResponse.json(
          { error: 'This connector does not support subtask creation' },
          { status: 403 },
        );
      }
      const connector = await getOrRefreshSubtaskConnector(parent.connectorInstanceId);
      if (!connector?.createSubTask) {
        return NextResponse.json(
          { error: 'This connector does not support subtask creation' },
          { status: 403 },
        );
      }
    }

    let expectedSnapshot: TaskSubtaskProposalSnapshot | null = null;
    if (proposalId && expectedContextVersion) {
      const previouslyAccepted = await ancillary.getTask(proposalId);
      if (previouslyAccepted) {
        if (previouslyAccepted.parentId !== id) {
          return NextResponse.json({ error: 'Proposal ID is already in use' }, { status: 409 });
        }
        const currentSnapshot = await ancillary.getSubtaskProposalSnapshot(id);
        return proposalReplayResponse(
          previouslyAccepted,
          currentSnapshot ? contextVersion(currentSnapshot) : expectedContextVersion,
        );
      }
      expectedSnapshot = await ancillary.getSubtaskProposalSnapshot(id);
      if (!expectedSnapshot || contextVersion(expectedSnapshot) !== expectedContextVersion) {
        const concurrentlyAccepted = await ancillary.getTask(proposalId);
        if (concurrentlyAccepted?.parentId === id) {
          const currentSnapshot = await ancillary.getSubtaskProposalSnapshot(id);
          return proposalReplayResponse(
            concurrentlyAccepted,
            currentSnapshot ? contextVersion(currentSnapshot) : expectedContextVersion,
          );
        }
        if (concurrentlyAccepted) {
          return NextResponse.json({ error: 'Proposal ID is already in use' }, { status: 409 });
        }
        return NextResponse.json(
          { error: 'This task changed after the breakdown was generated. Generate a fresh breakdown.' },
          { status: 409 },
        );
      }
      const duplicate = (await ancillary.listSubtasks(id))
        .find((subtask) => titleKey(subtask.title) === titleKey(title));
      if (duplicate) {
        return NextResponse.json({
          subtask: duplicate,
          contextVersion: expectedContextVersion,
          duplicate: true,
        });
      }
    }

    const subtaskId = proposalId || randomUUID();
    const now = new Date().toISOString();
    const task = buildSubtask(parent, {
      id: subtaskId,
      title,
      effort: effort ?? null,
      now,
      syncStatus: shouldWriteThrough ? 'pending_push' : 'synced',
    });

    let acceptedContextVersion: string | undefined;
    if (expectedSnapshot) {
      const outcome = await ancillary.acceptSubtaskProposal({ task, expected: expectedSnapshot });
      if (outcome.kind === 'stale') {
        return NextResponse.json(
          { error: 'This task changed after the breakdown was generated. Generate a fresh breakdown.' },
          { status: 409 },
        );
      }
      if (outcome.kind === 'id-conflict') {
        return NextResponse.json({ error: 'Proposal ID is already in use' }, { status: 409 });
      }
      if (outcome.kind === 'duplicate') {
        return NextResponse.json({
          subtask: outcome.subtask,
          contextVersion: contextVersion(outcome.snapshot),
          duplicate: true,
        });
      }
      acceptedContextVersion = contextVersion(outcome.snapshot);
    } else {
      const outcome = await ancillary.createSubtask({ task });
      if (outcome.kind === 'parent-not-found') {
        return NextResponse.json({ error: 'Parent task not found' }, { status: 404 });
      }
      if (outcome.kind === 'id-conflict') {
        return NextResponse.json({ error: 'Subtask ID is already in use' }, { status: 409 });
      }
      if (outcome.kind === 'already-created') {
        return NextResponse.json({ subtask: outcome.subtask, duplicate: true });
      }
    }

    if (shouldWriteThrough) {
      writeThroughSubtask({
        subtaskId,
        title,
        parentTaskId: parent.id,
        parentSourceId: parent.sourceId,
        connectorInstanceId: parent.connectorInstanceId,
      }).catch((error) => {
        logger.error({ err: error, subtaskId }, 'Write-through subtask request failed unexpectedly');
      });
    }

    return NextResponse.json({
      subtask: { id: subtaskId, title, status: 'todo', effort: effort ?? null },
      editPolicy: resolveTaskEditPolicy({
        sourceId: task.sourceId,
        connectorType: task.connectorType,
        connectorEnabled,
        forceLocal,
      }, capabilities),
      ...(acceptedContextVersion ? { contextVersion: acceptedContextVersion } : {}),
    });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to create subtask');
    return NextResponse.json({ error: 'Failed to create subtask' }, { status: 500 });
  }
}

async function writeThroughSubtask(params: {
  subtaskId: string;
  title: string;
  parentTaskId: string;
  parentSourceId: string;
  connectorInstanceId: string;
}) {
  try {
    const connector = await getOrRefreshSubtaskConnector(params.connectorInstanceId);
    if (!connector?.createSubTask) return;

    const createRemote = () => connector.createSubTask!(params.parentSourceId, {
      title: params.title,
      // Connector contracts still expose their own status union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: 'todo' as any,
    });
    const created = connector.type === 'github-issues'
      ? await executeFencedGitHubTaskMutation({
          connectorInstanceId: params.connectorInstanceId,
          taskId: params.subtaskId,
          operation: 'sub_issue',
          connector,
          participantTaskIds: [{ role: 'parent_issue', taskId: params.parentTaskId }],
          write: createRemote,
        })
      : await createRemote();

    const { ancillary } = await getTaskCorePersistence();
    await ancillary.completeSubtaskWriteThrough({
      taskId: params.subtaskId,
      expectedSyncStatus: 'pending_push',
      sourceId: created.sourceId,
      metadata: created.metadata || {},
      now: new Date().toISOString(),
    });
    await logWriteThrough({
      connectorId: params.connectorInstanceId,
      action: 'subtask_created',
      taskId: params.subtaskId,
      taskTitle: params.title,
      taskSourceId: created.sourceId,
    });
  } catch (error) {
    logger.error({ err: error, subtaskId: params.subtaskId }, 'Write-through subtask request failed');
    if (error instanceof GitHubUnknownWriteOutcomeError) {
      const { ancillary } = await getTaskCorePersistence();
      await ancillary.failSubtaskWriteThrough({
        taskId: params.subtaskId,
        expectedSyncStatus: 'pending_push',
      });
    }
  }
}
