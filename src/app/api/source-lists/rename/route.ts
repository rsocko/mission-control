import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';

/**
 * Body-based rename endpoint.
 *
 * The previous `/api/source-lists/[id]/rename` route put the source-list ID
 * into the URL path.  GitHub-connector IDs contain `/` (e.g.
 * `github-xxx:repo:octo-org/mission-control`), and percent-encoded slashes
 * (`%2F`) are silently decoded by many reverse proxies (Traefik, nginx, etc.)
 * _before_ the request reaches Next.js, breaking route matching.
 *
 * This static-path endpoint avoids the issue entirely: the ID travels in the
 * JSON body where encoding is irrelevant.
 *
 * IMPORTANT: Renaming is always a local-only operation (persists userDisplayName
 * in the DB). Remote write-back to the connector is best-effort and never
 * blocks the local rename. This means lists from read-only connectors (e.g.
 * GitHub) can still be renamed in the Mission Control UI.
 */
export async function PUT(request: Request) {
  try {
    const persistence = await getConnectorManagementPersistence();
    const body = await request.json();
    const { id, name, icon, iconColor } = body;

    if (!id || typeof id !== 'string') {
      return ApiErrors.badRequest('Source list id is required');
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return ApiErrors.badRequest('Name is required');
    }

    const newName = name.trim();
    const newIcon = typeof icon === 'string' ? (icon.trim() || null) : undefined;
    const newIconColor = typeof iconColor === 'string' ? (iconColor.trim() || null) : undefined;

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

    // Build the update payload — always set userDisplayName; optionally set icon fields
    // Write userDisplayName (and icon) IMMEDIATELY so any concurrent fetchData()
    // calls (e.g. from a running sync) will resolve the correct display name even
    // while the potentially slow remote rename is in flight.
    await persistence.applyLocalSourceListRename({
      sourceListId: id,
      name: newName,
      icon: newIcon,
      iconColor: newIconColor,
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
    logger.error({ err: error }, 'Source list rename failed');
    return NextResponse.json(
      { error: 'Failed to rename source list', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
