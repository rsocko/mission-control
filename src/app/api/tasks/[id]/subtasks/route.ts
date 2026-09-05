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
    return NextResponse.json({ subtasks: await ancillary.listSubtasks(id) });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to list subtasks');
    return NextResponse.json({ error: 'Failed to list subtasks' }, { status: 500 });
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
