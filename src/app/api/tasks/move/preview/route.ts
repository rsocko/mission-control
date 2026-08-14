import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, taskTags, taskProjects, taskSchedules, taskAttachments, tags, connectorConfigs, sourceLists, listGroups } from '@/db/schema';
import { eq, and, isNull, count } from 'drizzle-orm';
import { apiError, ApiErrors } from '@/lib/api-error';
import { computeFieldMappings, isGitHubNativeTransfer } from '@/lib/connectors/field-mapper';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import type { ConnectorCapabilities } from '@/types';
import { isPublicDemoMode } from '@/lib/public-demo';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';

/**
 * POST /api/tasks/move/preview
 *
 * Returns a preview of what moving/copying a task to a different connector would look like.
 * Includes field preservation details, unavoidable-loss warnings, and target-specific options.
 *
 * Body: { taskId, targetConnectorInstanceId, targetSourceListId? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, targetConnectorInstanceId, targetSourceListId } = body as {
      taskId: string;
      targetConnectorInstanceId: string;
      targetSourceListId?: string;
    };

    if (!taskId || !targetConnectorInstanceId) {
      return NextResponse.json(
        { error: 'taskId and targetConnectorInstanceId are required' },
        { status: 400 },
      );
    }

    // ── Fetch the source task ────────────────────────────────────────────────
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ── Fetch source task tags ───────────────────────────────────────────────
    const taskTagRows = await db
      .select({ name: tags.name, slug: tags.slug })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(eq(taskTags.taskId, taskId));

    // ── Count direct subtasks ────────────────────────────────────────────────
    const [subtaskCountRow] = await db
      .select({ count: count() })
      .from(tasks)
      .where(and(eq(tasks.parentId, taskId)));
    const subtaskCount = subtaskCountRow?.count ?? 0;

    // ── Fetch target connector config ────────────────────────────────────────
    const [targetConnector] = await db
      .select()
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.id, targetConnectorInstanceId), isNull(connectorConfigs.deletedAt)))
      .limit(1);

    if (!targetConnector) {
      return NextResponse.json({ error: 'Target connector not found' }, { status: 404 });
    }

    const storedCaps = targetConnector.capabilities as ConnectorCapabilities;
    const capDefaults = CAPABILITY_DEFAULTS[targetConnector.type] ?? {};
    const targetCaps = { ...capDefaults, ...storedCaps } as ConnectorCapabilities;
    if (!targetCaps?.write) {
      return NextResponse.json(
        { error: 'Target connector does not support write operations' },
        { status: 400 },
      );
    }
    if (!targetCaps?.taskCreate) {
      return NextResponse.json(
        { error: 'Target connector does not support task creation' },
        { status: 400 },
      );
    }
    if (
      targetSourceListId
      && task.connectorInstanceId === targetConnectorInstanceId
      && task.sourceListId === targetSourceListId
    ) {
      return apiError(
        'This task is already in the selected destination',
        'SAME_SOURCE_DESTINATION',
        409,
      );
    }

    // ── Fetch available target lists ─────────────────────────────────────────
    const targetListRows = await db
      .select({
        id: sourceLists.id,
        name: sourceLists.name,
        sourceId: sourceLists.sourceId,
        groupId: sourceLists.groupId,
        groupName: listGroups.name,
      })
      .from(sourceLists)
      .leftJoin(listGroups, eq(sourceLists.groupId, listGroups.id))
      .where(
        and(
          eq(sourceLists.connectorInstanceId, targetConnectorInstanceId),
          eq(sourceLists.hidden, false),
        ),
      )
      .orderBy(sourceLists.sortOrder, sourceLists.name);

    const targetLists = targetListRows
      .filter(row => isSourceListSelected(targetConnector, row))
      .map((row) => ({
        id: row.id,
        name: row.name,
        sourceId: row.sourceId,
        groupId: row.groupId,
        groupName: row.groupName,
      }));
    if (targetSourceListId && !targetLists.some(list => list.sourceId === targetSourceListId)) {
      return ApiErrors.badRequest('Target list is not selected for sync');
    }

    const [schedule] = await db
      .select({
        estimatedDuration: taskSchedules.estimatedDuration,
        recurrence: taskSchedules.recurrence,
        scheduledDate: taskSchedules.scheduledDate,
        scheduledTime: taskSchedules.scheduledTime,
        isTimeBlocked: taskSchedules.isTimeBlocked,
      })
      .from(taskSchedules)
      .where(eq(taskSchedules.taskId, taskId))
      .limit(1);

    const metadata = parseMetadata(task.metadata);
    const storedAttachmentRows = await db
      .select({ sourceAttachmentId: taskAttachments.sourceAttachmentId })
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, taskId));
    let attachmentCount = storedAttachmentRows.length;
    const isLocalSource = task.connectorType === 'local' || task.sourceId.startsWith('local:');
    if (!isPublicDemoMode() && !isLocalSource) {
      const sourceConnector = connectorRegistry.getConnector(task.connectorInstanceId)
        ?? await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId);
      if (sourceConnector?.listAttachments) {
        const storedSourceIds = new Set(
          storedAttachmentRows
            .map((attachment) => attachment.sourceAttachmentId)
            .filter((id): id is string => !!id),
        );
        const remoteAttachments = await sourceConnector.listAttachments(task.sourceId);
        attachmentCount += remoteAttachments.filter(
          (attachment) => !storedSourceIds.has(attachment.id),
        ).length;
      }
    }
    const [projectCountRow] = await db
      .select({ count: count() })
      .from(taskProjects)
      .where(eq(taskProjects.taskId, taskId));
    const projectCount = projectCountRow?.count ?? 0;

    // ── Compute field mappings ───────────────────────────────────────────────
    const fieldMappingResult = computeFieldMappings(
      task.connectorType,
      targetConnector.type,
      {
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        tags: taskTagRows,
        assignee: task.assignee,
        status: task.status,
        statusReason: task.statusReason,
        effort: task.effort,
        microStatus: task.microStatus,
        kanbanColumn: task.kanbanColumn,
        reminderAt: task.reminderAt,
        snoozedUntil: task.snoozedUntil,
        recurrence: schedule?.recurrence ?? (
          typeof metadata.recurrence === 'string' ? metadata.recurrence : null
        ),
        estimatedDuration: schedule?.estimatedDuration,
        scheduledDate: schedule?.scheduledDate,
        scheduledTime: schedule?.scheduledTime,
        isTimeBlocked: schedule?.isTimeBlocked,
        projectCount,
      },
      subtaskCount,
      attachmentCount,
      targetCaps.attachments === true,
    );

    // ── Detect GitHub native transfer ────────────────────────────────────────
    const resolvedTargetListId =
      targetSourceListId ||
      (targetLists.length === 1 ? targetLists[0].sourceId : undefined);

    const nativeTransferCandidate =
      !!resolvedTargetListId &&
      task.connectorInstanceId === targetConnectorInstanceId &&
      isGitHubNativeTransfer(
        task.connectorType,
        targetConnector.type,
        task.sourceListId || '',
        resolvedTargetListId,
      );
    const sourceConnector = nativeTransferCandidate && !isPublicDemoMode()
      ? connectorRegistry.getConnector(task.connectorInstanceId)
        ?? await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId)
      : null;
    const isNativeTransfer =
      nativeTransferCandidate
      && !!sourceConnector?.transferTask
      && (!sourceConnector.canTransferTask
        || await sourceConnector.canTransferTask(task.sourceId, resolvedTargetListId));

    // ── Determine available source actions ───────────────────────────────────
    // GitHub issues can't be deleted — only closed. We treat "move" as close+comment for GH sources.
    const sourceActions: Array<{
      action: 'move' | 'copy';
      label: string;
      description: string;
    }> = [
      {
        action: 'move',
        label: 'Move',
        description: fieldMappingResult.sourceSupportsDelete
          ? 'Create in target, then delete from source.'
          : 'Create in target, then close the source (deletion not supported by this source).',
      },
      {
        action: 'copy',
        label: 'Copy',
        description: 'Create in target and keep the original, with a cross-reference link.',
      },
    ];

    // ── Build suggestion hint ────────────────────────────────────────────────
    let suggestion: string | null = null;
    if (!fieldMappingResult.sourceSupportsDelete) {
      const reasons: string[] = [];
      if (!fieldMappingResult.sourceSupportsDelete)
        reasons.push('the source does not support true deletion');
      suggestion = `Consider "Copy" because ${reasons.join(' and ')}.`;
    }

    return NextResponse.json({
      task: {
        id: task.id,
        title: task.title,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        sourceListId: task.sourceListId,
      },
      targetConnector: {
        id: targetConnector.id,
        type: targetConnector.type,
        name: targetConnector.name,
      },
      targetLists,
      fieldMappings: fieldMappingResult.fieldMappings,
      subtasks: fieldMappingResult.subtasks,
      hasLossyFields: fieldMappingResult.hasLossyFields,
      isNativeTransfer: !!isNativeTransfer,
      nativeTransferNote: isNativeTransfer
        ? 'GitHub will transfer this issue with full history intact (comments, labels, timeline).'
        : null,
      sourceActions,
      suggestion,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to compute move preview', error);
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
