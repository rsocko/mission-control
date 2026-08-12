import { and, eq } from 'drizzle-orm';
import db from '@/db';
import { taskAttachments, tasks } from '@/db/schema';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';

const INLINE_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/yaml',
  'application/x-yaml',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/x-markdown',
]);

function isInlineContentType(contentType: string): boolean {
  return contentType.startsWith('audio/')
    || contentType.startsWith('video/')
    || INLINE_CONTENT_TYPES.has(contentType);
}

function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

function inferVerifiedContentType(contentType: string, name: string, bytes: Buffer): string {
  if (
    contentType === 'application/octet-stream'
    && name.toLowerCase().endsWith('.pdf')
    && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
    return 'application/pdf';
  }
  return contentType;
}

function contentDisposition(name: string, disposition: 'inline' | 'attachment'): string {
  const fallback = name
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .slice(0, 180) || 'attachment';
  const encoded = encodeURIComponent(name).replace(/'/g, '%27');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * GET /api/tasks/[id]/attachments/[attachmentId]
 * Returns task-scoped attachment bytes. Previewable types may opt into inline
 * display with ?inline=1; all other responses download by default.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id, attachmentId } = await params;

  try {
    const [task] = await db.select({
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(eq(tasks.id, id));

    if (!task) return ApiErrors.notFound('Task');

    const [localAttachment] = await db.select({
      name: taskAttachments.name,
      contentType: taskAttachments.contentType,
      contentBase64: taskAttachments.contentBase64,
      sourceAttachmentId: taskAttachments.sourceAttachmentId,
    }).from(taskAttachments).where(
      and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, id)),
    );

    const isLocal = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    let name = localAttachment?.name;
    let contentType = localAttachment?.contentType;
    let contentBase64 = localAttachment?.contentBase64;

    if (!contentBase64) {
      if (isLocal) return ApiErrors.notFound('Attachment');

      let connector = connectorRegistry.getConnector(task.connectorInstanceId) ?? null;
      if (!connector) {
        connector = await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId);
      }
      if (!connector?.getAttachmentContent) {
        return ApiErrors.badRequest('This connector does not support downloading attachments');
      }

      let sourceAttachmentId = localAttachment?.sourceAttachmentId;
      if (!sourceAttachmentId) {
        if (!connector.listAttachments) return ApiErrors.notFound('Attachment');
        const remoteAttachment = (await connector.listAttachments(task.sourceId))
          .find((attachment) => attachment.id === attachmentId);
        if (!remoteAttachment) return ApiErrors.notFound('Attachment');
        sourceAttachmentId = remoteAttachment.id;
        name = remoteAttachment.name;
        contentType = remoteAttachment.contentType;
      }

      const remoteContent = await connector.getAttachmentContent(task.sourceId, sourceAttachmentId);
      contentBase64 = remoteContent.contentBase64;
      contentType = remoteContent.contentType || contentType;
    }

    const bytes = Buffer.from(contentBase64, 'base64');
    const normalizedContentType = inferVerifiedContentType(
      normalizeContentType(contentType),
      name || 'attachment',
      bytes,
    );
    const wantsInline = new URL(request.url).searchParams.get('inline') === '1';
    const disposition = wantsInline && isInlineContentType(normalizedContentType)
      ? 'inline'
      : 'attachment';
    return new Response(bytes, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': contentDisposition(name || 'attachment', disposition),
        'Content-Length': String(bytes.byteLength),
        'Content-Type': normalizedContentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    logger.error({ err: error, taskId: id, attachmentId }, 'Failed to get attachment content');
    return ApiErrors.internal('Failed to get attachment content', error);
  }
}
