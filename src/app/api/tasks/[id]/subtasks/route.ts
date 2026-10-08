import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
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
} from '@/lib/external-identities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  TaskCoreTaskRow,
  TaskSubtaskProposalSnapshot,
} from '@/lib/tasks/core/contracts';
import {
  buildSubtaskTask,
  getOrRefreshSubtaskConnector,
  writeThroughSubtask,
} from '@/lib/tasks/subtask-creation';

const createSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
  planningHorizon: z.enum(['next', 'soon', 'later', 'someday']).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  effort: z.number().int().min(1).max(5).nullable().optional(),
  expectedContextVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposalId: z.string().uuid().optional(),
});

const reorderSubtasksSchema = z.object({
  orderedChildIds: z.array(z.string().min(1)).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Child IDs must be unique'),
  expectedRevision: z.number().int().nonnegative(),
});

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
    const {
      title,
      priority,
      planningHorizon,
      dueDate,
      effort,
      expectedContextVersion,
      proposalId,
    } = parsedBody.data;
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
    const task = buildSubtaskTask(parent, {
      id: subtaskId,
      title,
      priority: priority ?? 'none',
      planningHorizon: planningHorizon ?? null,
      dueDate: dueDate ?? null,
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
