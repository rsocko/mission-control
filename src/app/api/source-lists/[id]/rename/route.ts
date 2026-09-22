import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';

/**
 * @deprecated — The [id]-in-path approach breaks when the source-list ID
 * contains `/` (e.g. GitHub repos) because reverse proxies decode `%2F`
 * before the request reaches Next.js.  Use `PUT /api/source-lists/rename`
 * (body-based) instead.  This handler is kept for backward compatibility.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const persistence = await getConnectorManagementPersistence();
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const newName = name.trim();

    // Get the source list from DB
    const sourceList = await persistence.getSourceList(id);

    if (!sourceList) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    // Connector must be enabled (but write capability is NOT required —
    // renaming is a local UI operation that never blocks on remote writes)
    if (!(await isConnectorEnabled(sourceList.connectorInstanceId))) {
      return ApiErrors.forbidden('Connector is disabled');
    }

    // Validate name before any DB writes
    const emojiWarning = validateNameForGraphApi(newName);
    if (emojiWarning) {
      return NextResponse.json(
        { error: emojiWarning, code: 'UNSAFE_EMOJI' },
        { status: 422 },
      );
    }

    // Write userDisplayName IMMEDIATELY so any concurrent fetchData() calls
    // (e.g. from a running sync) will resolve the correct display name even
    // while the potentially slow remote rename is in flight.
    await persistence.applyLocalSourceListRename({
      sourceListId: id,
      name: newName,
    });

    // Attempt write-back to the remote connector (best-effort — only if connector
    // supports writes). Never blocks the local rename.
    const caps = await getConnectorCapabilities(sourceList.connectorInstanceId);
    const connectorSupportsWrite = !caps || caps.write !== false;
    let remoteRenameSucceeded = false;

    if (connectorSupportsWrite) {
      try {
        const connector = getConnectorRegistry().getConnector(sourceList.connectorInstanceId);

        if (connector && typeof connector.renameList === 'function') {
          await connector.renameList(sourceList.sourceId, newName);
          remoteRenameSucceeded = true;
        }
      } catch (err) {
        // Remote rename failed — local rename is already persisted so this is safe.
        logger.warn({ err, sourceListId: id }, 'Remote source list rename failed (local rename still saved)');
      }
    }

    // If the remote rename also succeeded, update `name` and `lastKnownRemoteName`
    // so local and remote stay in sync.
    if (remoteRenameSucceeded) {
      await persistence.confirmRemoteSourceListRename(id, newName);
    }

    return NextResponse.json({ success: true, name: newName });
  } catch (error) {
    logger.error({ err: error, sourceListId: id }, 'Source list rename failed');
    return NextResponse.json(
      { error: 'Failed to rename source list', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
