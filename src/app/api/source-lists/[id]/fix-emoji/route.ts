import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { IConnector } from '@/lib/connectors';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import {
  ConnectorOperationBusyError,
  runWithConnectorOperationLease,
} from '@/lib/sync/connector-lock';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import type {
  ConnectorManagementPersistence,
  SourceListRepairMoveResult,
  SourceListRepairRecord,
  SourceListRepairTask,
} from '@/db/persistence/connector-management';
import type { SourceListRecord } from '@/db/persistence/connector-execution';

/**
 * Fix a list affected by the Graph API emoji bug.
 * 
 * Two strategies:
 * - "strip-emoji": Remove the leading emoji from the list name (JSON response).
 * - "migrate": Create new list, move all tasks, delete old. Returns SSE stream with progress.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { strategy, newName } = body as { strategy: 'strip-emoji' | 'migrate'; newName?: string };

    if (!strategy || !['strip-emoji', 'migrate'].includes(strategy)) {
      return NextResponse.json(
        { error: 'Invalid strategy. Must be "strip-emoji" or "migrate".' },
        { status: 400 },
      );
    }

    const persistence = await getConnectorManagementPersistence();
    const repairId = sourceListRepairId(
      id,
      strategy,
      request.headers.get('idempotency-key'),
    );
    const completedRepair = await persistence.getSourceListRepair(repairId);
    if (completedRepair?.status === 'completed') {
      return completedRepairResponse(completedRepair);
    }
    const sourceList = await persistence.getSourceList(id);

    if (!sourceList) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    // Guard: connector must be enabled and allow writes
    const caps = await getConnectorCapabilities(sourceList.connectorInstanceId);
    if (!(await isConnectorEnabled(sourceList.connectorInstanceId))) {
      return ApiErrors.forbidden('Connector is disabled');
    }
    if (caps && caps.write === false) {
      return ApiErrors.forbidden('Write capability is disabled for this connector');
    }

    const connector = getConnectorRegistry().getConnector(sourceList.connectorInstanceId);
    if (!connector) {
      return NextResponse.json(
        { error: 'Connector not initialized. Try syncing first.' },
        { status: 503 },
      );
    }

    const cleanName = newName || stripEmojiPrefix(sourceList.name);

    // Validate the new name won't also be hidden
    const emojiWarning = validateNameForGraphApi(cleanName);
    if (emojiWarning) {
      return NextResponse.json(
        { error: emojiWarning, code: 'UNSAFE_EMOJI' },
        { status: 422 },
      );
    }

    if (strategy === 'strip-emoji') {
      return await runWithConnectorOperationLease(
        sourceList.connectorInstanceId,
        'transfer',
        () => handleStripEmoji(
          sourceList,
          connector,
          cleanName,
          newName,
          repairId,
          persistence,
        ),
      );
    }
    return handleMigrateStream(
      sourceList,
      connector,
      cleanName,
      repairId,
      persistence,
    );
  } catch (error) {
    if (error instanceof ConnectorOperationBusyError) {
      return NextResponse.json(
        { error: error.message, code: 'CONNECTOR_BUSY' },
        { status: 409 },
      );
    }
    logger.error({ err: error, sourceListId: id }, 'Fix emoji request failed');
    return NextResponse.json(
      { error: 'Fix failed', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

function sourceListRepairId(
  sourceListId: string,
  strategy: 'strip-emoji' | 'migrate',
  idempotencyKey: string | null,
): string {
  const digest = createHash('sha256')
    .update(`${sourceListId}\0${strategy}\0${idempotencyKey ?? 'default'}`)
    .digest('hex')
    .slice(0, 32);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20),
  ].join('-');
}

function stripEmojiPrefix(name: string): string {
  if (!name) return name;
  const cp = name.codePointAt(0) || 0;
  if (cp > 0x2600) {
    const charLen = cp > 0xFFFF ? 2 : 1;
    return name.substring(charLen).trim();
  }
  return name;
}

// --- Strip Emoji (simple rename) ---

async function handleStripEmoji(
  sourceList: SourceListRecord,
  connector: IConnector | undefined,
  cleanName: string,
  newName: string | undefined,
  repairId: string,
  persistence: ConnectorManagementPersistence,
) {
  if (!connector || !connector.renameList) {
    return NextResponse.json({ error: 'Connector does not support renaming' }, { status: 501 });
  }

  const { repair } = await persistence.beginSourceListRepair({
    id: repairId,
    createdAt: new Date().toISOString(),
    strategy: 'strip-emoji',
    sourceList,
    newName: cleanName,
  });
  if (repair.status === 'completed') {
    return completedRepairResponse(repair);
  }

  await connector.renameList(sourceList.sourceId, cleanName);

  // Only update userDisplayName if it also has the emoji prefix that needs stripping.
  // If the user had a completely custom display name, preserve it.
  let userDisplayName: string | undefined;
  if (sourceList.userDisplayName) {
    const udnCp = sourceList.userDisplayName.codePointAt(0) || 0;
    if (udnCp >= 0x10000) {
      userDisplayName = newName || stripEmojiPrefix(sourceList.userDisplayName);
    }
  }
  const outcome = await persistence.finalizeSourceListRepair({
    strategy: 'strip-emoji',
    id: repairId,
    sourceListId: sourceList.id,
    expectedOriginalName: sourceList.name,
    newName: cleanName,
    userDisplayName,
  });
  if (outcome === 'conflict') {
    return NextResponse.json(
      { error: 'Source list changed during repair', code: 'REPAIR_CONFLICT' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    success: true,
    strategy: 'strip-emoji',
    auditId: repairId,
    originalName: sourceList.name,
    newName: cleanName,
    message: `Renamed "${sourceList.name}" to "${cleanName}". Now visible to Graph API.`,
    undoInfo: `To undo: rename back to "${sourceList.name}" via Settings or To Do app.`,
  });
}

function completedRepairResponse(repair: SourceListRepairRecord): Response {
  if (repair.strategy === 'strip-emoji') {
    return NextResponse.json({
      success: true,
      strategy: 'strip-emoji',
      auditId: repair.id,
      originalName: repair.originalName,
      newName: repair.newName,
      message: `Renamed "${repair.originalName}" to "${repair.newName}". Now visible to Graph API.`,
      undoInfo: `To undo: rename back to "${repair.originalName}" via Settings or To Do app.`,
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `event: complete\ndata: ${JSON.stringify(responseBodyForCompletedRepair(repair))}\n\n`,
      ));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// --- Migrate (SSE stream with live progress) ---

function handleMigrateStream(
  sourceList: SourceListRecord,
  connector: IConnector,
  cleanName: string,
  repairId: string,
  persistence: ConnectorManagementPersistence,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const completion = await runWithConnectorOperationLease(
          sourceList.connectorInstanceId,
          'transfer',
          () => executeMigration({
            sourceList,
            connector,
            cleanName,
            repairId,
            persistence,
            send,
          }),
        );
        if (completion) send('complete', completion);
      } catch (err) {
        send('error', { message: `Unexpected: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

interface MigrationExecutionInput {
  sourceList: SourceListRecord;
  connector: IConnector;
  cleanName: string;
  repairId: string;
  persistence: ConnectorManagementPersistence;
  send: (event: string, data: unknown) => void;
}

async function executeMigration(input: MigrationExecutionInput) {
  const {
    sourceList,
    connector,
    cleanName,
    repairId,
    persistence,
    send,
  } = input;
  if (!connector.createList || !connector.moveTaskToList) {
    send('error', { message: 'Connector does not support list creation or task migration' });
    return null;
  }

  const { repair } = await persistence.beginSourceListRepair({
    id: repairId,
    createdAt: new Date().toISOString(),
    strategy: 'migrate',
    sourceList,
    newName: cleanName,
  });
  if (repair.status === 'completed') {
    return responseBodyForCompletedRepair(repair);
  }

  let newListId = repair.newListId;
  if (!newListId) {
    send('phase', { phase: 'creating', message: `Creating "${cleanName}"...` });
    try {
      const newList = await connector.createList(cleanName);
      newListId = newList.id;
      await persistence.checkpointSourceListRepair({
        id: repairId,
        status: 'running',
        newListId,
      });
    } catch (err) {
      await persistence.checkpointSourceListRepair({ id: repairId, status: 'failed' });
      send('error', {
        message: `Failed to create list: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  }
  send('phase', { phase: 'created', message: `Created "${cleanName}"`, newListId });

  let taskSnapshot: SourceListRepairTask[] = [...repair.taskSnapshot];
  if (taskSnapshot.length === 0) {
    send('phase', { phase: 'fetching', message: 'Fetching all tasks (including completed)...' });
    try {
      taskSnapshot = await fetchAllRemoteTasks(connector, sourceList.sourceId);
      await persistence.checkpointSourceListRepair({
        id: repairId,
        status: 'running',
        newListId,
        taskSnapshot,
      });
    } catch (err) {
      await persistence.checkpointSourceListRepair({
        id: repairId,
        status: 'failed',
        newListId,
      });
      send('error', {
        message: `Failed to fetch tasks: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  }

  send('phase', {
    phase: 'moving',
    message: taskSnapshot.length === 0
      ? 'No tasks to move.'
      : `Moving ${taskSnapshot.length} task(s)...`,
    total: taskSnapshot.length,
  });

  const resultsByTaskId = new Map(
    repair.moveResults.map((result) => [result.taskId, result]),
  );
  for (let index = 0; index < taskSnapshot.length; index += 1) {
    const task = taskSnapshot[index];
    const previous = resultsByTaskId.get(task.id);
    if (!previous?.success) {
      let result: SourceListRepairMoveResult;
      try {
        const compositeId = `${sourceList.sourceId}:${task.id}`;
        const movedTaskId = await connector.moveTaskToList(compositeId, newListId);
        result = {
          taskId: task.id,
          title: task.title,
          status: task.status,
          newTaskId: movedTaskId || undefined,
          success: true,
        };
      } catch (err) {
        result = {
          taskId: task.id,
          title: task.title,
          status: task.status,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      resultsByTaskId.set(task.id, result);
      await persistence.checkpointSourceListRepair({
        id: repairId,
        status: 'running',
        newListId,
        taskSnapshot,
        moveResults: [...resultsByTaskId.values()],
      });
    }
    const moveResults = [...resultsByTaskId.values()];
    const moved = moveResults.filter((result) => result.success).length;
    const current = resultsByTaskId.get(task.id);
    send('progress', {
      current: index + 1,
      total: taskSnapshot.length,
      moved,
      failed: (index + 1) - moved,
      currentTask: task.title,
      currentStatus: task.status,
      success: current?.success ?? false,
      percent: taskSnapshot.length === 0
        ? 100
        : Math.round(((index + 1) / taskSnapshot.length) * 100),
    });
  }

  const moveResults = taskSnapshot.map((task) => (
    resultsByTaskId.get(task.id) ?? {
      taskId: task.id,
      title: task.title,
      status: task.status,
      success: false,
      error: 'Task move was not attempted',
    }
  ));
  const moved = moveResults.filter((result) => result.success).length;
  const allMoved = moved === taskSnapshot.length;
  let oldListDeleted = repair.oldListDeleted;
  if (allMoved && taskSnapshot.length > 0 && connector.deleteList && !oldListDeleted) {
    send('phase', { phase: 'cleanup', message: 'Removing old list...' });
    try {
      await connector.deleteList(sourceList.sourceId);
      oldListDeleted = true;
      await persistence.checkpointSourceListRepair({
        id: repairId,
        status: 'running',
        newListId,
        taskSnapshot,
        moveResults,
        oldListDeleted,
      });
    } catch {
      // The old list remains available when cleanup fails.
    }
  }

  const status = allMoved ? 'completed' : moved > 0 ? 'partial' : 'failed';
  const finalized = await persistence.finalizeSourceListRepair({
    strategy: 'migrate',
    id: repairId,
    sourceListId: sourceList.id,
    expectedOriginalName: sourceList.name,
    status,
    newListId,
    taskSnapshot,
    moveResults,
    oldListDeleted,
  });
  if (finalized === 'conflict') {
    send('error', { message: 'Source list changed during repair' });
    return null;
  }

  if (allMoved) {
    send('phase', { phase: 'verifying', message: 'Verifying new list is Graph API visible...' });
    let graphVisible = false;
    try {
      const graphFetch = (
        connector as IConnector & {
          graphFetch?: (path: string) => Promise<Response>;
        }
      ).graphFetch?.bind(connector);
      if (graphFetch) {
        const verifyRes = await graphFetch(
          `/me/todo/lists/${encodeURIComponent(newListId)}`,
        );
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json() as { displayName?: string };
          graphVisible = verifyData.displayName === cleanName;
        }
      }
    } catch {
      // Verification is advisory and does not undo a completed migration.
    }
    send('phase', {
      phase: 'verified',
      message: graphVisible
        ? `✓ "${cleanName}" confirmed visible in Graph API`
        : 'New list created but Graph visibility unconfirmed',
      graphVisible,
    });
    try {
      fetch(`http://localhost:${process.env.PORT || 3099}/api/sync`, {
        method: 'POST',
      }).catch((error) => {
        logger.error({ err: error }, 'Failed to trigger background resync');
      });
    } catch {
      // The durable repair is complete even if the follow-up sync cannot start.
    }
  }

  return {
    success: allMoved,
    auditId: repairId,
    originalName: sourceList.name,
    newName: cleanName,
    newListId,
    tasksMoved: moved,
    tasksTotal: taskSnapshot.length,
    tasksFailed: taskSnapshot.length - moved,
    oldListDeleted,
    message: allMoved
      ? `Done! Moved ${moved} task(s) to "${cleanName}".${oldListDeleted ? ' Old list removed.' : ''}`
      : `Moved ${moved}/${taskSnapshot.length}. ${taskSnapshot.length - moved} failed. Old list kept.`,
    undoInfo: oldListDeleted
      ? `Audit ID: ${repairId}. Full task snapshot saved for recovery.`
      : `Old list still exists (empty). Tasks now in "${cleanName}".`,
  };
}

function responseBodyForCompletedRepair(repair: SourceListRepairRecord) {
  return {
    success: true,
    auditId: repair.id,
    originalName: repair.originalName,
    newName: repair.newName,
    newListId: repair.newListId,
    tasksMoved: repair.tasksMoved,
    tasksTotal: repair.tasksTotal,
    tasksFailed: repair.tasksFailed,
    oldListDeleted: repair.oldListDeleted,
    message: `Done! Moved ${repair.tasksMoved} task(s) to "${repair.newName}".${repair.oldListDeleted ? ' Old list removed.' : ''}`,
    undoInfo: repair.oldListDeleted
      ? `Audit ID: ${repair.id}. Full task snapshot saved for recovery.`
      : `Old list still exists (empty). Tasks now in "${repair.newName}".`,
  };
}

async function fetchAllRemoteTasks(
  connector: IConnector,
  listSourceId: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphFetch = (connector as any).graphFetch?.bind(connector);
  if (!graphFetch) {
    throw new Error('Connector does not expose graphFetch for task enumeration');
  }

  const allTasks: Array<{ id: string; title: string; status: string }> = [];
  let url: string | null = `/me/todo/lists/${encodeURIComponent(listSourceId)}/tasks?$top=100`;

  while (url) {
    const res: Response = await graphFetch(url);
    if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
    const data = await res.json();
    for (const item of (data.value || [])) {
      allTasks.push({
        id: item.id,
        title: item.title || '[Untitled]',
        status: item.status || 'notStarted',
      });
    }
    url = data['@odata.nextLink']
      ? data['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '')
      : null;
  }

  return allTasks;
}