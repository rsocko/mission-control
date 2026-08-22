import { eq } from 'drizzle-orm';
import db from '@/db';
import { connectorConfigs, tasks } from '@/db/schema';
import { apiError, ApiErrors } from '@/lib/api-error';
import {
  getDocumentIntelligenceApiKey,
  getDocumentIntelligenceBaseUrl,
} from '@/lib/connectors/document-intelligence';
import logger from '@/lib/logger';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parseRecord(value))) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function parseDocumentId(value: unknown): string | null {
  const normalized = typeof value === 'number' ? String(value) : value;
  return typeof normalized === 'string' && /^[1-9]\d*$/.test(normalized)
    ? normalized
    : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const [task] = await db.select({
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      metadata: tasks.metadata,
    }).from(tasks).where(eq(tasks.id, id)).limit(1);

    if (!task) return ApiErrors.notFound('Task');
    if (task.connectorType !== 'document-intelligence') {
      return ApiErrors.badRequest('Document previews are available only for OWL tasks');
    }

    const metadata = parseTaskMetadataCompat(task.metadata).metadata;
    const documentId = parseDocumentId(metadata.documentId);
    if (!documentId) {
      return ApiErrors.badRequest('The OWL task does not contain a valid document ID');
    }

    const [connector] = await db.select({
      type: connectorConfigs.type,
      enabled: connectorConfigs.enabled,
      deletedAt: connectorConfigs.deletedAt,
      credentials: connectorConfigs.credentials,
      settings: connectorConfigs.settings,
    }).from(connectorConfigs)
      .where(eq(connectorConfigs.id, task.connectorInstanceId))
      .limit(1);

    if (
      !connector
      || connector.type !== 'document-intelligence'
      || !connector.enabled
      || connector.deletedAt
    ) {
      return ApiErrors.notFound('OWL connector');
    }

    const credentials = parseStringRecord(connector.credentials);
    const settings = parseRecord(connector.settings);
    const baseUrl = getDocumentIntelligenceBaseUrl(settings);
    const apiKey = getDocumentIntelligenceApiKey(credentials, settings);
    const headers: HeadersInit = { Accept: 'application/pdf' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers['X-API-Key'] = apiKey;
    }

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/api/documents/${encodeURIComponent(documentId)}/download`,
        {
          headers,
          cache: 'no-store',
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch (error) {
      logger.warn({ err: error, taskId: id, documentId }, 'OWL document preview request failed');
      return apiError('OWL could not load the document preview', 'OWL_PREVIEW_FAILED', 502);
    }
    if (!response.ok) {
      logger.warn(
        { taskId: id, documentId, status: response.status },
        'OWL document preview request failed',
      );
      return apiError('OWL could not load the document preview', 'OWL_PREVIEW_FAILED', 502);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PREVIEW_BYTES) {
      return apiError('The OWL document preview is too large', 'OWL_PREVIEW_TOO_LARGE', 413);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PREVIEW_BYTES) {
      return apiError('The OWL document preview is too large', 'OWL_PREVIEW_TOO_LARGE', 413);
    }
    const isPdf = bytes.length >= 5
      && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
    if (!isPdf) {
      logger.warn(
        { taskId: id, documentId, contentType: response.headers.get('content-type') },
        'OWL document preview returned non-PDF content',
      );
      return apiError('OWL returned an unsupported document preview', 'OWL_PREVIEW_UNSUPPORTED', 502);
    }

    return new Response(bytes, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `inline; filename="document-${documentId}.pdf"`,
        'Content-Length': String(bytes.byteLength),
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to proxy OWL document preview');
    return ApiErrors.internal('Failed to load OWL document preview', error);
  }
}
