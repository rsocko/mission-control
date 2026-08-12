import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { hubProjects, tags, taskProjects, tasks, taskTags } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler, logWriteThrough } from '@/lib/sync';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { createBreakdownContextVersion, titleKey } from '@/lib/ai/task-breakdown';
import { isPublicDemoMode } from '@/lib/public-demo';
import { isDemoMode } from '@/lib/mode';
import { resolveTaskFieldPolicy } from '@/lib/tasks/field-policy';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import { z } from 'zod';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';

const createSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  effort: z.number().int().min(1).max(5).nullable().optional(),
  expectedContextVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposalId: z.string().uuid().optional(),
});

/**
 * GET /api/tasks/[id]/subtasks — List subtasks/checklist items for a task
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const subtaskRows = await db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      priority: tasks.priority,
    }).from(tasks).where(eq(tasks.parentId, id));

    return NextResponse.json({ subtasks: subtaskRows });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to list subtasks');
    return NextResponse.json({ error: 'Failed to list subtasks' }, { status: 500 });
  }
}

/**
 * POST /api/tasks/[id]/subtasks — Add a subtask/step to a task
 * Immediate write-through: creates locally, then pushes checklist item to source.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
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

    // Verify parent task exists
    const [parent] = await db.select().from(tasks).where(eq(tasks.id, id));
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
      const connector = connectorRegistry.getConnector(parent.connectorInstanceId)
        ?? await syncScheduler.initializeConnectorFromDb(parent.connectorInstanceId);
      if (!connector?.createSubTask) {
        return NextResponse.json(
          { error: 'This connector does not support subtask creation' },
          { status: 403 },
        );
      }
    }

    const subtaskId = proposalId || randomUUID();
    const now = new Date().toISOString();
    const values = {
      id: subtaskId,
      title,
      status: 'todo',
      priority: 'none',
      effort: effort ?? null,
      connectorType: parent.connectorType,
      connectorInstanceId: parent.connectorInstanceId,
      sourceListId: parent.sourceListId,
      sourceListName: parent.sourceListName,
      parentId: id,
      depth: (parent.depth || 0) + 1,
      isChecklistItem: true,
      sourceId: subtaskId,
      syncStatus: shouldWriteThrough ? 'pending_push' : 'synced',
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    let acceptedContextVersion: string | undefined;
    if (proposalId && expectedContextVersion) {
      const result = runTransaction((tx) => {
        const previouslyAccepted = tx.select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          effort: tasks.effort,
          parentId: tasks.parentId,
        }).from(tasks).where(eq(tasks.id, proposalId)).get();
        const freshParent = tx.select({ updatedAt: tasks.updatedAt })
          .from(tasks)
          .where(eq(tasks.id, id))
          .get();
        const currentTags = tx.select({ name: tags.name })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(eq(taskTags.taskId, id))
          .limit(20)
          .all();
        const currentProjects = tx.select({ name: hubProjects.name })
          .from(taskProjects)
          .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
          .where(eq(taskProjects.taskId, id))
          .limit(10)
          .all();
        const currentSubtasks = tx.select({ title: tasks.title })
          .from(tasks)
          .where(eq(tasks.parentId, id))
          .limit(30)
          .all();
        if (!freshParent) {
          return { kind: 'stale' } as const;
        }
        const currentContextVersion = createBreakdownContextVersion({
          updatedAt: freshParent.updatedAt,
          tags: currentTags.map((row) => row.name),
          projects: currentProjects.map((row) => row.name),
          existingSubtasks: currentSubtasks.map((row) => row.title),
        });
        if (previouslyAccepted) {
          return previouslyAccepted.parentId === id
            ? {
                kind: 'duplicate',
                subtask: previouslyAccepted,
                contextVersion: currentContextVersion,
              } as const
            : { kind: 'conflict' } as const;
        }
        if (currentContextVersion !== expectedContextVersion) {
          return { kind: 'stale' } as const;
        }

        const existingChildren = tx.select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          effort: tasks.effort,
        }).from(tasks).where(eq(tasks.parentId, id)).all();
        const duplicate = existingChildren.find((subtask) => titleKey(subtask.title) === titleKey(title));
        if (duplicate) {
          return {
            kind: 'duplicate',
            subtask: duplicate,
            contextVersion: currentContextVersion,
          } as const;
        }

        tx.insert(tasks).values(values).run();
        const updatedSubtasks = tx.select({ title: tasks.title })
          .from(tasks)
          .where(eq(tasks.parentId, id))
          .limit(30)
          .all();
        return {
          kind: 'created',
          contextVersion: createBreakdownContextVersion({
            updatedAt: freshParent.updatedAt,
            tags: currentTags.map((row) => row.name),
            projects: currentProjects.map((row) => row.name),
            existingSubtasks: updatedSubtasks.map((row) => row.title),
          }),
        } as const;
      });

      if (result.kind === 'stale') {
        return NextResponse.json(
          { error: 'This task changed after the breakdown was generated. Generate a fresh breakdown.' },
          { status: 409 },
        );
      }
      if (result.kind === 'conflict') {
        return NextResponse.json({ error: 'Proposal ID is already in use' }, { status: 409 });
      }
      if (result.kind === 'duplicate') {
        return NextResponse.json({
          subtask: result.subtask,
          contextVersion: result.contextVersion,
          duplicate: true,
        });
      }
      acceptedContextVersion = result.contextVersion;
    } else {
      await db.insert(tasks).values(values);
    }

    // Immediate write-through for remote tasks
    if (shouldWriteThrough) {
      writeThroughSubtask({
        subtaskId,
        title,
        parentTaskId: parent.id,
        parentSourceId: parent.sourceId,
        connectorInstanceId: parent.connectorInstanceId,
      }).catch((err) => {
        logger.error({ err, subtaskId }, 'Write-through subtask request failed unexpectedly');
      });
    }

    return NextResponse.json({
      subtask: { id: subtaskId, title, status: 'todo', effort: effort ?? null },
      editPolicy: resolveTaskEditPolicy({
        sourceId: values.sourceId,
        connectorType: values.connectorType,
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

/**
 * Attempt immediate write-through for a newly created subtask/checklist item.
 * On success: updates local subtask with the real sourceId and marks synced.
 * On failure: subtask stays pending_push for retry on next sync cycle.
 */
async function writeThroughSubtask(params: {
  subtaskId: string;
  title: string;
  parentTaskId: string;
  parentSourceId: string;
  connectorInstanceId: string;
}) {
  try {
    let connector = connectorRegistry.getConnector(params.connectorInstanceId) ?? null;
    if (!connector) {
      connector = await syncScheduler.initializeConnectorFromDb(params.connectorInstanceId);
    }
    if (!connector || !connector.createSubTask) {
      // Connector doesn't support subtask creation — leave as pending_push
      return;
    }

    const createRemote = () => connector.createSubTask!(params.parentSourceId, {
        title: params.title,
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

    // Update local subtask with the real source ID
    await db.update(tasks).set({
      sourceId: created.sourceId,
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
      metadata: JSON.stringify(created.metadata || {}),
    }).where(eq(tasks.id, params.subtaskId));

    await logWriteThrough({
      connectorId: params.connectorInstanceId,
      action: 'subtask_created',
      taskId: params.subtaskId,
      taskTitle: params.title,
      taskSourceId: created.sourceId,
    });
  } catch (err) {
    logger.error({ err, subtaskId: params.subtaskId }, 'Write-through subtask request failed');
    if (err instanceof GitHubUnknownWriteOutcomeError) {
      await db.update(tasks).set({
        syncStatus: 'push_failed',
        pushRetryCount: 5,
      }).where(eq(tasks.id, params.subtaskId));
    }
  }
}
