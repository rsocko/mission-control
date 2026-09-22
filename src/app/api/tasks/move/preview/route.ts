import { NextResponse } from 'next/server';
import { apiError, ApiErrors } from '@/lib/api-error';
import { computeFieldMappings, isGitHubNativeTransfer } from '@/lib/connectors/field-mapper';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import type { ConnectorCapabilities } from '@/types';
import { isPublicDemoMode } from '@/lib/public-demo';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

type CapabilityKey = 'write' | 'taskCreate' | 'attachments';

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

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
    const body: unknown = await request.json();
    const rawTaskId = readField(body, 'taskId');
    const rawTargetConnectorInstanceId = readField(body, 'targetConnectorInstanceId');
    const rawTargetSourceListId = readField(body, 'targetSourceListId');

    const taskId = typeof rawTaskId === 'string' ? rawTaskId : '';
    const targetConnectorInstanceId = typeof rawTargetConnectorInstanceId === 'string'
      ? rawTargetConnectorInstanceId
      : '';
    const targetSourceListId = typeof rawTargetSourceListId === 'string'
      ? rawTargetSourceListId
      : undefined;

    if (!taskId || !targetConnectorInstanceId) {
      return NextResponse.json(
        { error: 'taskId and targetConnectorInstanceId are required' },
        { status: 400 },
      );
    }

    // ── Fetch the source task, its tags, schedule, attachments and counts ────
    const persistence = await getTaskCorePersistence();
    const snapshot = await persistence.organization.getTaskMovePreviewSnapshot(taskId);
    if (!snapshot) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const { task, tags: taskTagRows, subtaskCount, schedule, projectCount } = snapshot;

    // ── Fetch target connector config ────────────────────────────────────────
    const management = await getConnectorManagementPersistence();
    const targetConnector = await management.getConnector(targetConnectorInstanceId);

    if (!targetConnector || targetConnector.deletedAt !== null) {
      return NextResponse.json({ error: 'Target connector not found' }, { status: 404 });
    }

    const storedCaps = targetConnector.capabilities;
    const capDefaults: Partial<ConnectorCapabilities> = CAPABILITY_DEFAULTS[targetConnector.type] ?? {};
    // Reproduces `{ ...capDefaults, ...storedCaps }` without asserting the
    // persisted record into `ConnectorCapabilities`.
    const targetCapability = (key: CapabilityKey): unknown => {
      const stored = Object.getOwnPropertyDescriptor(storedCaps, key);
      return stored ? stored.value : capDefaults[key];
    };
    if (!targetCapability('write')) {
      return NextResponse.json(
        { error: 'Target connector does not support write operations' },
        { status: 400 },
      );
    }
    if (!targetCapability('taskCreate')) {
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
    const listSnapshot = await management.getConnectorListSnapshot(targetConnectorInstanceId);
    const groupNames = new Map(listSnapshot.groups.map((group) => [group.id, group.name]));

    const targetLists = listSnapshot.sourceLists
      .filter(row => !row.hidden && isSourceListSelected(targetConnector, row))
      .map((row) => ({
        id: row.id,
        name: row.name,
        sourceId: row.sourceId,
        groupId: row.groupId,
        groupName: row.groupId === null ? null : groupNames.get(row.groupId) ?? null,
      }));
    if (targetSourceListId && !targetLists.some(list => list.sourceId === targetSourceListId)) {
      return ApiErrors.badRequest('Target list is not selected for sync');
    }

    const metadata = task.metadata;
    let attachmentCount = snapshot.storedAttachmentCount;
    const isLocalSource = task.connectorType === 'local' || task.sourceId.startsWith('local:');
    if (!isPublicDemoMode() && !isLocalSource) {
      const sourceConnector = await getOrInitializeConnector(task.connectorInstanceId);
      if (sourceConnector?.listAttachments) {
        const storedSourceIds = new Set(snapshot.storedAttachmentSourceIds);
        const remoteAttachments = await sourceConnector.listAttachments(task.sourceId);
        attachmentCount += remoteAttachments.filter(
          (attachment) => !storedSourceIds.has(attachment.id),
        ).length;
      }
    }

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
        planningHorizon: task.planningHorizon,
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
      targetCapability('attachments') === true,
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
      ? await getOrInitializeConnector(task.connectorInstanceId)
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
