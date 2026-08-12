import { NextResponse } from 'next/server';
import db from '@/db';
import { sourceLists, listFixAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import { randomUUID } from 'crypto';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';

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

    const [sourceList] = await db
      .select()
      .from(sourceLists)
      .where(eq(sourceLists.id, id))
      .limit(1);

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

    const connector = connectorRegistry.getConnector(sourceList.connectorInstanceId);
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
      return await handleStripEmoji(sourceList, connector, cleanName, newName);
    } else {
      return handleMigrateStream(sourceList, connector, cleanName);
    }
  } catch (error) {
    logger.error({ err: error, sourceListId: id }, 'Fix emoji request failed');
    return NextResponse.json(
      { error: 'Fix failed', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
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
  sourceList: { id: string; sourceId: string; name: string; userDisplayName?: string | null; connectorInstanceId: string; groupId: string | null },
  connector: ReturnType<typeof connectorRegistry.getConnector>,
  cleanName: string,
  newName?: string,
) {
  if (!connector || !connector.renameList) {
    return NextResponse.json({ error: 'Connector does not support renaming' }, { status: 501 });
  }

  const auditId = randomUUID();
  const now = new Date().toISOString();

  await connector.renameList(sourceList.sourceId, cleanName);

  // Only update userDisplayName if it also has the emoji prefix that needs stripping.
  // If the user had a completely custom display name, preserve it.
  const updateSet: Record<string, string> = { name: cleanName, lastKnownRemoteName: cleanName };
  if (sourceList.userDisplayName) {
    const udnCp = sourceList.userDisplayName.codePointAt(0) || 0;
    if (udnCp >= 0x10000) {
      updateSet.userDisplayName = newName || stripEmojiPrefix(sourceList.userDisplayName);
    }
  }
  await db.update(sourceLists).set(updateSet).where(eq(sourceLists.id, sourceList.id));

  await db.insert(listFixAuditLog).values({
    id: auditId,
    createdAt: now,
    strategy: 'strip-emoji',
    status: 'completed',
    originalListId: sourceList.id,
    originalSourceId: sourceList.sourceId,
    originalName: sourceList.name,
    originalGroupId: sourceList.groupId,
    connectorInstanceId: sourceList.connectorInstanceId,
    newListId: null,
    newName: cleanName,
    taskSnapshot: null,
    moveResults: null,
    tasksTotal: 0,
    tasksMoved: 0,
    tasksFailed: 0,
    oldListDeleted: false,
  });

  return NextResponse.json({
    success: true,
    strategy: 'strip-emoji',
    auditId,
    originalName: sourceList.name,
    newName: cleanName,
    message: `Renamed "${sourceList.name}" to "${cleanName}". Now visible to Graph API.`,
    undoInfo: `To undo: rename back to "${sourceList.name}" via Settings or To Do app.`,
  });
}

// --- Migrate (SSE stream with live progress) ---

function handleMigrateStream(
  sourceList: { id: string; sourceId: string; name: string; connectorInstanceId: string; groupId: string | null },
  connector: NonNullable<ReturnType<typeof connectorRegistry.getConnector>>,
  cleanName: string,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const auditId = randomUUID();
      const now = new Date().toISOString();

      try {
        if (!connector.createList || !connector.moveTaskToList) {
          send('error', { message: 'Connector does not support list creation or task migration' });
          controller.close();
          return;
        }

        // Phase 1: Create new list
        send('phase', { phase: 'creating', message: `Creating "${cleanName}"...` });

        let newList: { id: string; displayName: string };
        try {
          newList = await connector.createList(cleanName);
        } catch (err) {
          send('error', { message: `Failed to create list: ${err instanceof Error ? err.message : String(err)}` });
          controller.close();
          return;
        }
        const newListId = newList.id;
        send('phase', { phase: 'created', message: `Created "${cleanName}"`, newListId });

        // Phase 2: Fetch all tasks (including completed)
        send('phase', { phase: 'fetching', message: 'Fetching all tasks (including completed)...' });

        let remoteTasks: Array<{ id: string; title: string; status: string }> = [];
        try {
          remoteTasks = await fetchAllRemoteTasks(connector, sourceList.sourceId);
        } catch (err) {
          send('error', { message: `Failed to fetch tasks: ${err instanceof Error ? err.message : String(err)}` });
          await writeAudit(auditId, now, 'failed', sourceList, newListId, cleanName, [], [], false);
          controller.close();
          return;
        }

        if (remoteTasks.length === 0) {
          send('phase', { phase: 'moving', message: 'No tasks to move.', total: 0 });
        } else {
          send('phase', { phase: 'moving', message: `Moving ${remoteTasks.length} task(s)...`, total: remoteTasks.length });
        }

        // Phase 3: Move tasks one by one with progress events
        let moved = 0;
        const moveResults: MoveResult[] = [];

        for (let i = 0; i < remoteTasks.length; i++) {
          const task = remoteTasks[i];
          let newTaskId: string | undefined;
          let success = false;
          let error: string | undefined;

          try {
            const compositeId = `${sourceList.sourceId}:${task.id}`;
            const result = await connector.moveTaskToList(compositeId, newListId);
            newTaskId = result || undefined;
            moved++;
            success = true;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }

          moveResults.push({ taskId: task.id, title: task.title, status: task.status, newTaskId, success, error });

          send('progress', {
            current: i + 1,
            total: remoteTasks.length,
            moved,
            failed: (i + 1) - moved,
            currentTask: task.title,
            currentStatus: task.status,
            success,
            percent: Math.round(((i + 1) / remoteTasks.length) * 100),
          });
        }

        // Phase 4: Cleanup
        let oldListDeleted = false;
        const allMoved = moved === remoteTasks.length;

        if (allMoved && remoteTasks.length > 0 && connector.deleteList) {
          send('phase', { phase: 'cleanup', message: 'Removing old list...' });
          try {
            await connector.deleteList(sourceList.sourceId);
            oldListDeleted = true;
          } catch {
            // Non-fatal
          }
        }

        // Phase 5: Update local DB — remove old list, verify new list in Graph
        if (allMoved) {
          send('phase', { phase: 'verifying', message: 'Verifying new list is Graph API visible...' });
          
          // Remove old source_list entry from local DB
          try {
            await db.delete(sourceLists).where(eq(sourceLists.id, sourceList.id));
          } catch { /* non-critical */ }

          // Verify new list appears in Graph API listing
          let graphVisible = false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const graphFetch = (connector as any).graphFetch?.bind(connector);
            if (graphFetch) {
              const verifyRes: Response = await graphFetch(`/me/todo/lists/${encodeURIComponent(newListId)}`);
              if (verifyRes.ok) {
                const verifyData = await verifyRes.json();
                graphVisible = verifyData.displayName === cleanName;
              }
            }
          } catch { /* non-critical */ }

          send('phase', { 
            phase: 'verified', 
            message: graphVisible 
              ? `✓ "${cleanName}" confirmed visible in Graph API` 
              : `New list created but Graph visibility unconfirmed`,
            graphVisible,
          });

          // Trigger background re-sync to update UI
          try {
            fetch(`http://localhost:${process.env.PORT || 3099}/api/sync`, { method: 'POST' }).catch((e) => {
              logger.error({ err: e }, 'Failed to trigger background resync');
            });
          } catch { /* fire and forget */ }
        }

        // Phase 6: Write audit log
        await writeAudit(
          auditId, now, allMoved ? 'completed' : (moved > 0 ? 'partial' : 'failed'),
          sourceList, newListId, cleanName, remoteTasks, moveResults, oldListDeleted,
        );

        // Final completion event
        send('complete', {
          success: allMoved,
          auditId,
          originalName: sourceList.name,
          newName: cleanName,
          newListId,
          tasksMoved: moved,
          tasksTotal: remoteTasks.length,
          tasksFailed: remoteTasks.length - moved,
          oldListDeleted,
          message: allMoved
            ? `Done! Moved ${moved} task(s) to "${cleanName}".${oldListDeleted ? ' Old list removed.' : ''}`
            : `Moved ${moved}/${remoteTasks.length}. ${remoteTasks.length - moved} failed. Old list kept.`,
          undoInfo: oldListDeleted
            ? `Audit ID: ${auditId}. Full task snapshot saved for recovery.`
            : `Old list still exists (empty). Tasks now in "${cleanName}".`,
        });

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

// --- Helpers ---

interface MoveResult {
  taskId: string;
  title: string;
  status: string;
  newTaskId?: string;
  success: boolean;
  error?: string;
}

async function writeAudit(
  auditId: string,
  createdAt: string,
  status: string,
  sourceList: { id: string; sourceId: string; name: string; connectorInstanceId: string; groupId: string | null },
  newListId: string,
  newName: string,
  taskSnapshot: Array<{ id: string; title: string; status: string }>,
  moveResults: MoveResult[],
  oldListDeleted: boolean,
) {
  const moved = moveResults.filter(r => r.success).length;
  await db.insert(listFixAuditLog).values({
    id: auditId,
    createdAt,
    strategy: 'migrate',
    status,
    originalListId: sourceList.id,
    originalSourceId: sourceList.sourceId,
    originalName: sourceList.name,
    originalGroupId: sourceList.groupId,
    connectorInstanceId: sourceList.connectorInstanceId,
    newListId,
    newName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskSnapshot: taskSnapshot as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moveResults: moveResults as any,
    tasksTotal: taskSnapshot.length,
    tasksMoved: moved,
    tasksFailed: taskSnapshot.length - moved,
    oldListDeleted,
  });
}

async function fetchAllRemoteTasks(
  connector: NonNullable<ReturnType<typeof connectorRegistry.getConnector>>,
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