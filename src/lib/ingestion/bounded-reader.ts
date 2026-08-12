import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  ingestionRejectionReason,
  recordIngestionOutcome,
  type IngestionSource,
} from './telemetry';

export class IngestionLimitError extends Error {
  readonly code = 'INGESTION_LIMIT_EXCEEDED';
  readonly limit: number;
  readonly actual?: number;

  constructor(message: string, limit: number, actual?: number) {
    super(message);
    this.name = 'IngestionLimitError';
    this.limit = limit;
    this.actual = actual;
  }
}

export class IngestionTimeoutError extends Error {
  readonly code = 'INGESTION_TIMEOUT';

  constructor(message = 'Ingestion request timed out') {
    super(message);
    this.name = 'IngestionTimeoutError';
  }
}

export class IngestionValidationError extends Error {
  readonly code = 'INGESTION_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'IngestionValidationError';
  }
}

export const INGESTION_LIMITS = {
  requestBytes: 1_048_576,
  documentBytes: 5_242_880,
  embedHtmlBytes: 1_048_576,
  thumbnailBytes: 5_242_880,
  intakeTimeoutMs: 15_000,
  embedTimeoutMs: 10_000,
  thumbnailTimeoutMs: 10_000,
  intakeProcessingTimeoutMs: 120_000,
  maxRedirects: 3,
} as const;

function declaredLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  limit: number,
  options: {
    signal?: AbortSignal;
    label?: string;
    source?: IngestionSource;
    recordTelemetry?: boolean;
  } = {},
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const label = options.label ?? 'Response body';
  const source = options.source ?? 'unknown';
  const startedAt = performance.now();

  try {
    while (true) {
      const { done, value } = await readNextChunk(reader, options.signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new IngestionLimitError(`${label} exceeds the ${limit}-byte limit`, limit, total);
      }
      chunks.push(value);
    }
    if (options.recordTelemetry !== false) {
      recordIngestionOutcome({
        source,
        outcome: 'accepted',
        bytes: total,
        durationMs: performance.now() - startedAt,
      });
    }
  } catch (error) {
    if (options.recordTelemetry !== false) {
      recordIngestionOutcome({
        source,
        outcome: 'rejected',
        bytes: error instanceof IngestionLimitError ? error.actual ?? total : total,
        durationMs: performance.now() - startedAt,
        reason: ingestionRejectionReason(error),
      });
    }
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readLimitedResponse(
  response: Response,
  limit: number,
  options: {
    signal?: AbortSignal;
    label?: string;
    source?: IngestionSource;
    recordTelemetry?: boolean;
  } = {},
): Promise<Uint8Array> {
  const length = declaredLength(response.headers);
  if (length !== undefined && length > limit) {
    await response.body?.cancel().catch(() => undefined);
    if (options.recordTelemetry !== false) {
      recordIngestionOutcome({
        source: options.source ?? 'unknown',
        outcome: 'rejected',
        bytes: length,
        durationMs: 0,
        reason: 'limit',
      });
    }
    throw new IngestionLimitError(
      `${options.label ?? 'Response body'} exceeds the ${limit}-byte limit`,
      limit,
      length,
    );
  }
  return readLimitedStream(response.body, limit, options);
}

export async function readLimitedRequest(
  request: Request,
  limit: number,
  label = 'Request body',
  signal: AbortSignal = request.signal,
): Promise<Uint8Array> {
  const length = declaredLength(request.headers);
  if (length !== undefined && length > limit) {
    await request.body?.cancel().catch(() => undefined);
    recordIngestionOutcome({
      source: 'request',
      outcome: 'rejected',
      bytes: length,
      durationMs: 0,
      reason: 'limit',
    });
    throw new IngestionLimitError(`${label} exceeds the ${limit}-byte limit`, limit, length);
  }
  return readLimitedStream(request.body, limit, { signal, label, source: 'request' });
}

export async function readLimitedFile(
  filePath: string,
  limit: number,
  options: { approvedRoots: string[]; label?: string; signal?: AbortSignal },
): Promise<Uint8Array> {
  const startedAt = performance.now();
  let observedBytes = 0;
  try {
    options.signal?.throwIfAborted();
    const absolutePath = resolve(filePath);
    const roots = await Promise.all(options.approvedRoots.map(async root => {
      try { return await realpath(resolve(root)); } catch { return resolve(root); }
    }));
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absolutePath);
    } catch {
      throw new IngestionValidationError('Document file could not be resolved');
    }
    if (!isAbsolute(filePath) || !roots.some(root => {
      const relativePath = relative(root, resolvedPath);
      return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
    })) {
      throw new IngestionValidationError('File path is outside the approved document roots');
    }

    const file = await import('node:fs/promises').then(fs => fs.open(resolvedPath, 'r'));
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new IngestionValidationError('Document path is not a file');
      if (metadata.size > limit) {
        throw new IngestionLimitError(`${options.label ?? 'Document file'} exceeds the ${limit}-byte limit`, limit, metadata.size);
      }

      const chunks: Buffer[] = [];
      while (true) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - observedBytes));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        observedBytes += bytesRead;
        if (observedBytes > limit) {
          throw new IngestionLimitError(`${options.label ?? 'Document file'} exceeds the ${limit}-byte limit`, limit, observedBytes);
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      options.signal?.throwIfAborted();
      const result = new Uint8Array(Buffer.concat(chunks, observedBytes));
      recordIngestionOutcome({
        source: 'local-file',
        outcome: 'accepted',
        bytes: observedBytes,
        durationMs: performance.now() - startedAt,
      });
      return result;
    } finally {
      await file.close();
    }
  } catch (error) {
    recordIngestionOutcome({
      source: 'local-file',
      outcome: 'rejected',
      bytes: error instanceof IngestionLimitError ? error.actual ?? observedBytes : observedBytes,
      durationMs: performance.now() - startedAt,
      reason: ingestionRejectionReason(error),
    });
    throw error;
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new IngestionTimeoutError()), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function approvedDocumentRoots(): string[] {
  const configured = process.env.MC_DOCUMENT_APPROVED_ROOTS
    ?.split(/[;,]/)
    .map(value => value.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : [resolve(process.env.MC_DATA_DIR || './data')];
}

function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  signal.throwIfAborted();

  return new Promise((resolveRead, rejectRead) => {
    const abort = () => rejectRead(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      result => {
        signal.removeEventListener('abort', abort);
        resolveRead(result);
      },
      error => {
        signal.removeEventListener('abort', abort);
        rejectRead(error);
      },
    );
  });
}
