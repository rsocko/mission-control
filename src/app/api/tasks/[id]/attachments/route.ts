import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getConnectorCapabilities } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { ConnectorConfig } from '@/types';

/** Max upload size: 25MB (matches MS Todo upload session limit) */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

async function getOrRefreshAttachmentConnector(connectorInstanceId: string) {
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

/**
 * GET /api/tasks/[id]/attachments — List attachments for a task.
 * For remote connectors with attachment support, fetches from source.
 * For local tasks, reads from the task_attachments table.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const { ancillary } = await getTaskCorePersistence();
    const { task, attachments: localAttachments } =
      await ancillary.getAttachmentListContext(id);

    if (!task) return ApiErrors.notFound('Task');

    const isLocal = task.sourceId.startsWith('local:') || task.connectorType === 'local';

    const toAttachmentMetadata = (attachment: typeof localAttachments[number]) => ({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      createdAt: attachment.createdAt,
    });

    if (isLocal) {
      return NextResponse.json({
        attachments: localAttachments.map(toAttachmentMetadata),
      });
    }

    // Remote: check if connector supports attachments
    const caps = await getConnectorCapabilities(task.connectorInstanceId);
    if (!caps?.attachments) {
      return NextResponse.json({
        attachments: localAttachments.map(toAttachmentMetadata),
        supported: false,
        preservedLocally: localAttachments.length > 0,
      });
    }

    const connector = await getOrRefreshAttachmentConnector(task.connectorInstanceId);
    if (!connector?.listAttachments) {
      return NextResponse.json({ attachments: [], supported: false });
    }

    const remoteAttachments = await connector.listAttachments(task.sourceId);
    const locallyPreserved = localAttachments
      .filter((attachment) => attachment.hasLocalContent)
      .map(toAttachmentMetadata);
    return NextResponse.json({
      attachments: [...remoteAttachments, ...locallyPreserved],
      supported: true,
      preservedLocally: locallyPreserved.length > 0,
    });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to list attachments');
    return ApiErrors.internal('Failed to list attachments', error);
  }
}

/**
 * POST /api/tasks/[id]/attachments — Upload an attachment.
 * Body: { name: string, contentType: string, contentBase64: string }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { name, contentType, contentBase64 } = body;

    if (!name || !contentType || !contentBase64) {
      return NextResponse.json(
        { error: 'Missing required fields: name, contentType, contentBase64' },
        { status: 400 },
      );
    }

    const sizeBytes = Math.ceil(contentBase64.length * 3 / 4);
    if (sizeBytes > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` },
        { status: 413 },
      );
    }

    const { ancillary } = await getTaskCorePersistence();
    const task = await ancillary.getTask(id);

    if (!task) return ApiErrors.notFound('Task');

    const isLocal = task.sourceId.startsWith('local:') || task.connectorType === 'local';

    if (isLocal) {
      // Store locally
      const attachmentId = randomUUID();
      const outcome = await ancillary.insertAttachment({
        id: attachmentId,
        taskId: id,
        name,
        contentType,
        size: sizeBytes,
        contentBase64,
        createdAt: new Date().toISOString(),
      });
      if (outcome.kind === 'task-not-found') return ApiErrors.notFound('Task');

      return NextResponse.json({
        attachment: { id: attachmentId, name, contentType, size: sizeBytes },
      });
    }

    // Remote: upload to connector
    const caps = await getConnectorCapabilities(task.connectorInstanceId);
    if (!caps?.attachments) {
      return NextResponse.json(
        { error: 'This connector does not support file attachments' },
        { status: 400 },
      );
    }

    const connector = await getOrRefreshAttachmentConnector(task.connectorInstanceId);
    if (!connector?.uploadAttachment) {
      return NextResponse.json(
        { error: 'Connector does not support uploading attachments' },
        { status: 400 },
      );
    }

    const result = await connector.uploadAttachment(task.sourceId, { name, contentType, contentBase64 });

    // Also store a reference locally (without content to save space)
    const localId = randomUUID();
    const outcome = await ancillary.insertAttachment({
      id: localId,
      taskId: id,
      name: result.name,
      contentType,
      size: result.size,
      sourceAttachmentId: result.id,
      createdAt: new Date().toISOString(),
    });
    if (outcome.kind === 'task-not-found') return ApiErrors.notFound('Task');

    return NextResponse.json({
      attachment: { id: localId, sourceAttachmentId: result.id, name: result.name, contentType, size: result.size },
    });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to upload attachment');
    return ApiErrors.internal('Failed to upload attachment', error);
  }
}

/**
 * DELETE /api/tasks/[id]/attachments — Delete an attachment.
 * Query: ?attachmentId=xxx
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(request.url);
  const attachmentId = url.searchParams.get('attachmentId');

  if (!attachmentId) {
    return NextResponse.json({ error: 'Missing attachmentId query param' }, { status: 400 });
  }

  try {
    const { ancillary } = await getTaskCorePersistence();
    const { task, attachment: localAttachment } =
      await ancillary.getAttachmentDeleteContext(id, attachmentId);

    if (!task) return ApiErrors.notFound('Task');

    if (!localAttachment) {
      return ApiErrors.notFound('Attachment');
    }

    const isLocal = task.sourceId.startsWith('local:') || task.connectorType === 'local';

    if (!isLocal && localAttachment.sourceAttachmentId) {
      // Delete from remote too
      const caps = await getConnectorCapabilities(task.connectorInstanceId);
      if (caps?.attachments) {
        const connector = await getOrRefreshAttachmentConnector(task.connectorInstanceId);
        if (connector?.deleteAttachment) {
          await connector.deleteAttachment(task.sourceId, localAttachment.sourceAttachmentId);
        }
      }
    }

    // Delete local record
    const removed = await ancillary.deleteAttachment({
      taskId: id,
      attachmentId,
      expectedSourceAttachmentId: localAttachment.sourceAttachmentId,
    });
    if (!removed) {
      return NextResponse.json(
        { error: 'Attachment changed while it was being deleted' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ err: error, taskId: id, attachmentId }, 'Failed to delete attachment');
    return ApiErrors.internal('Failed to delete attachment', error);
  }
}
