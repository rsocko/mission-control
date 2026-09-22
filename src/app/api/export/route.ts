import {
  createExportStream,
  ExportAdmissionController,
  type ExportFormat,
  type ExportLimits,
  type ExportPage,
  type ExportResult,
  type ExportSource,
} from '@/lib/export-stream';
import type {
  ExportTaskTagCursor,
  OperationalExportRecord,
  OperationalExportRepository,
} from '@/db/persistence/operational-utility';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { exportLogger } from '@/lib/logger';
import { startRuntimeOperation } from '@/lib/runtime/lifecycle';
import { getLocalToday } from '@/lib/utils/date';
import { beginRuntimeOperation } from '@/lib/telemetry/operations';

const CSV_HEADERS = [
  'id',
  'title',
  'status',
  'priority',
  'dueDate',
  'connectorType',
  'sourceListName',
  'createdAt',
] as const;
const VALID_FORMATS = new Set(['json', 'csv']);
const VALID_TYPES = new Set(['all', 'tasks', 'alerts', 'notifications', 'tags', 'projects']);

function boundedEnvironmentInteger(
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  const configured = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return defaultValue;
  return Math.min(configured, maximum);
}

function getExportLimits(): ExportLimits {
  return {
    batchSize: boundedEnvironmentInteger('MC_EXPORT_BATCH_SIZE', 50, 250),
    maxBytes: boundedEnvironmentInteger('MC_EXPORT_MAX_BYTES', 100 * 1024 * 1024, 1024 * 1024 * 1024),
    maxDurationMs: boundedEnvironmentInteger('MC_EXPORT_MAX_DURATION_MS', 60_000, 10 * 60_000),
    maxRecords: boundedEnvironmentInteger('MC_EXPORT_MAX_RECORDS', 250_000, 1_000_000),
  };
}

const exportAdmission = new ExportAdmissionController(
  boundedEnvironmentInteger('MC_EXPORT_MAX_CONCURRENCY', 2, 8),
);

async function page(
  read: () => Promise<OperationalExportRecord[]>,
  signal: AbortSignal,
  limit: number,
  cursorFor: (record: OperationalExportRecord) => unknown,
): Promise<ExportPage> {
  if (signal.aborted) throw signal.reason;
  const records = await read();
  if (signal.aborted) throw signal.reason;
  return {
    records,
    nextCursor: records.length === limit ? cursorFor(records[records.length - 1]) : undefined,
  };
}

function textCursor(cursor: unknown): string | undefined {
  return typeof cursor === 'string' ? cursor : undefined;
}

function recordId(record: OperationalExportRecord): unknown {
  return record.id;
}

/**
 * Task-tag pages are ordered by `(taskId, tagId)`, so the cursor is emitted and
 * parsed in that same declared order.
 */
function taskTagCursor(cursor: unknown): ExportTaskTagCursor | undefined {
  if (
    typeof cursor !== 'object'
    || cursor === null
    || !('taskId' in cursor)
    || !('tagId' in cursor)
    || typeof cursor.taskId !== 'string'
    || typeof cursor.tagId !== 'string'
  ) {
    return undefined;
  }
  return { taskId: cursor.taskId, tagId: cursor.tagId };
}

function createSources(type: string, exports: OperationalExportRepository): ExportSource[] {
  const sources: ExportSource[] = [];
  if (type === 'all' || type === 'tasks') {
    sources.push({
      name: 'tasks',
      readPage: (cursor, limit, signal) => page(
        () => exports.listTasksPage({ afterId: textCursor(cursor), limit }),
        signal,
        limit,
        recordId,
      ),
    });
  }
  if (type === 'all' || type === 'alerts' || type === 'notifications') {
    sources.push({
      name: 'notifications',
      readPage: (cursor, limit, signal) => page(
        () => exports.listNotificationsPage({ afterId: textCursor(cursor), limit }),
        signal,
        limit,
        recordId,
      ),
    });
  }
  if (type === 'all' || type === 'tags') {
    sources.push(
      {
        name: 'tags',
        readPage: (cursor, limit, signal) => page(
          () => exports.listTagsPage({ afterId: textCursor(cursor), limit }),
          signal,
          limit,
          recordId,
        ),
      },
      {
        name: 'taskTags',
        readPage: (cursor, limit, signal) => page(
          () => exports.listTaskTagsPage({ after: taskTagCursor(cursor), limit }),
          signal,
          limit,
          (record) => ({ taskId: record.taskId, tagId: record.tagId }),
        ),
      },
    );
  }
  if (type === 'all' || type === 'projects') {
    sources.push({
      name: 'hubProjects',
      readPage: (cursor, limit, signal) => page(
        () => exports.listHubProjectsPage({ afterId: textCursor(cursor), limit }),
        signal,
        limit,
        recordId,
      ),
    });
  }
  if (type === 'all') {
    sources.push(
      {
        name: 'connectors',
        readPage: (cursor, limit, signal) => page(
          () => exports.listConnectorsPage({ afterId: textCursor(cursor), limit }),
          signal,
          limit,
          recordId,
        ),
      },
      {
        name: 'syncLog',
        readPage: (() => {
          let exported = 0;
          return async (cursor: unknown, limit: number, signal: AbortSignal) => {
            if (exported >= 100) return { records: [] };
            const pageLimit = Math.min(limit, 100 - exported);
            const result = await page(
              () => exports.listSyncLogPage({ afterId: textCursor(cursor), limit: pageLimit }),
              signal,
              pageLimit,
              recordId,
            );
            exported += result.records.length;
            return result;
          };
        })(),
      },
    );
  }
  return sources;
}

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status });
}

function isAuthorizedExportRequest(request: Request): boolean {
  if (isTrustedMutationRequest(request)) return true;

  // Same-origin GET navigations generally omit Origin, but Fetch Metadata is
  // browser-controlled and still distinguishes in-app downloads from cross-site requests.
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Streams a bounded export. Browser callers must be same-origin; automation
 * callers must provide MC_API_KEY via ****** X-MC-API-Key authentication.
 */
export async function GET(request: Request) {
  if (!isAuthorizedExportRequest(request)) {
    exportLogger.warn({ reason: 'unauthorized' }, 'Export rejected');
    return errorResponse(401, 'Unauthorized');
  }

  const { searchParams } = new URL(request.url);
  const formatValue = searchParams.get('format') || 'json';
  const type = searchParams.get('type') || 'all';
  if (!VALID_FORMATS.has(formatValue)) {
    exportLogger.warn({ format: formatValue, reason: 'invalid_format', type }, 'Export rejected');
    return errorResponse(400, 'format must be json or csv');
  }
  if (!VALID_TYPES.has(type)) {
    exportLogger.warn({ format: formatValue, reason: 'invalid_type', type }, 'Export rejected');
    return errorResponse(400, 'Unsupported export type');
  }

  const { operationalUtility } = await getWorkerPersistenceRepositories();
  if (!operationalUtility) {
    exportLogger.warn({ format: formatValue, reason: 'persistence_unavailable', type }, 'Export rejected');
    return errorResponse(
      503,
      'Operational utility persistence is not available in the selected backend',
    );
  }

  const format = formatValue as ExportFormat;
  const requester = request.headers.get('authorization') || request.headers.get('x-mc-api-key')
    ? 'api-key'
    : new URL(request.url).host;
  const runtimeOperation = startRuntimeOperation('export');
  if (!runtimeOperation.accepted) {
    exportLogger.warn({ format, reason: 'runtime_draining', type }, 'Export rejected');
    return Response.json(
      { error: 'Service is draining' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }
  const admission = exportAdmission.acquire(`${requester}:${format}:${type}`);
  if (!admission.acquired) {
    runtimeOperation.finish();
    exportLogger.warn(
      { activeExports: exportAdmission.activeCount, format, reason: admission.reason, type },
      'Export rejected',
    );
    return Response.json(
      { error: admission.reason === 'duplicate' ? 'Equivalent export already active' : 'Export capacity reached' },
      { status: 429, headers: { 'Retry-After': '5' } },
    );
  }

  const limits = getExportLimits();
  const sources = createSources(
    format === 'csv' && type !== 'all' && type !== 'tasks' ? 'none' : type,
    operationalUtility.exports,
  );
  const finishTelemetry = beginRuntimeOperation({
    kind: 'export',
    name: `${format}:${type}`,
    traceId: request.headers.get('x-trace-id') ?? undefined,
    routeFamily: '/api/export',
  });
  exportLogger.info(
    { activeExports: exportAdmission.activeCount, format, limits, type },
    'Export started',
  );

  const onFinish = (result: ExportResult) => {
    admission.release();
    runtimeOperation.finish();
    finishTelemetry();
    const fields = {
      activeExports: exportAdmission.activeCount,
      bytes: result.bytes,
      durationMs: result.durationMs,
      errorCode: result.errorCode,
      format,
      outcome: result.outcome,
      records: result.records,
      type,
    };
    if (result.outcome === 'completed') {
      exportLogger.info(fields, 'Export completed');
    } else if (result.outcome === 'cancelled') {
      exportLogger.warn(fields, 'Export cancelled');
    } else {
      exportLogger.error(fields, 'Export failed');
    }
  };

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = createExportStream({
      csvHeaders: CSV_HEADERS,
      exportedAt: new Date().toISOString(),
      format,
      limits,
      onFinish,
      requestSignal: AbortSignal.any([request.signal, runtimeOperation.signal]),
      sources,
    });
  } catch (error) {
    admission.release();
    runtimeOperation.finish();
    finishTelemetry();
    exportLogger.error(
      { activeExports: exportAdmission.activeCount, err: error, format, type },
      'Export initialization failed',
    );
    return errorResponse(500, 'Export initialization failed');
  }
  const extension = format === 'csv' ? 'csv' : 'json';

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="mission-control-export-${getLocalToday()}.${extension}"`,
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
