import 'server-only';

export type ExportFormat = 'json' | 'csv';

export interface ExportLimits {
  batchSize: number;
  maxBytes: number;
  maxDurationMs: number;
  maxRecords: number;
}

export interface ExportSource {
  name: string;
  readPage: (
    cursor: unknown,
    limit: number,
    signal: AbortSignal,
  ) => Promise<ExportPage>;
}

export interface ExportPage {
  nextCursor?: unknown;
  records: readonly Record<string, unknown>[];
}

export type ExportOutcome = 'completed' | 'cancelled' | 'failed';

export interface ExportResult {
  bytes: number;
  durationMs: number;
  errorCode?: ExportStreamErrorCode;
  outcome: ExportOutcome;
  records: number;
}

export type ExportStreamErrorCode =
  | 'byte_limit'
  | 'cancelled'
  | 'duration_limit'
  | 'record_limit'
  | 'serialization_error';

export class ExportStreamError extends Error {
  constructor(
    public readonly code: ExportStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExportStreamError';
  }
}

export type ExportAdmissionFailure = 'capacity' | 'duplicate';

export class ExportAdmissionController {
  private readonly activeKeys = new Set<string>();

  constructor(private readonly maxActive: number) {}

  get activeCount() {
    return this.activeKeys.size;
  }

  acquire(key: string):
    | { acquired: false; reason: ExportAdmissionFailure }
    | { acquired: true; release: () => void } {
    if (this.activeKeys.has(key)) {
      return { acquired: false, reason: 'duplicate' };
    }
    if (this.activeKeys.size >= this.maxActive) {
      return { acquired: false, reason: 'capacity' };
    }

    this.activeKeys.add(key);
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeKeys.delete(key);
      },
    };
  }
}

interface ExportChunk {
  record: boolean;
  text: string;
}

interface CreateExportStreamOptions {
  csvHeaders?: readonly string[];
  format: ExportFormat;
  limits: ExportLimits;
  onFinish: (result: ExportResult) => void;
  requestSignal: AbortSignal;
  sources: readonly ExportSource[];
  exportedAt: string;
}

function serializeJsonRecord(record: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(record, null, 2);
    if (serialized === undefined) {
      throw new TypeError('JSON.stringify returned undefined');
    }
    return serialized.split('\n').map((line) => `    ${line}`).join('\n');
  } catch (error) {
    throw new ExportStreamError(
      'serialization_error',
      'A record could not be serialized as JSON',
      { cause: error },
    );
  }
}

function serializeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const serialized = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(raw)
    ? `'${raw}`
    : raw;
  return /[",\r\n]/.test(serialized)
    ? `"${serialized.replaceAll('"', '""')}"`
    : serialized;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function measureRawValueBytes(value: unknown, seen: Set<object>): number {
  if (typeof value === 'string') return utf8ByteLength(value);
  if (value === null || value === undefined || typeof value !== 'object') return 0;
  if (seen.has(value)) {
    throw new ExportStreamError('serialization_error', 'A record could not be serialized as JSON');
  }

  seen.add(value);
  let bytes = 0;
  if (Array.isArray(value)) {
    for (const item of value) bytes += measureRawValueBytes(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      bytes += utf8ByteLength(key) + measureRawValueBytes(item, seen);
    }
  }
  seen.delete(value);
  return bytes;
}

function assertRecordMayFit(record: Record<string, unknown>, remainingBytes: number): void {
  if (measureRawValueBytes(record, new Set()) > remainingBytes) {
    throw new ExportStreamError('byte_limit', 'Export byte limit exceeded');
  }
}

async function* readRecords(
  source: ExportSource,
  limits: ExportLimits,
  signal: AbortSignal,
  assertWithinDuration: () => void,
) {
  let cursor: unknown;
  while (true) {
    assertWithinDuration();
    if (signal.aborted) {
      throw new ExportStreamError('cancelled', 'Export cancelled');
    }

    const page = await source.readPage(cursor, limits.batchSize, signal);
    assertWithinDuration();
    if (signal.aborted) {
      throw new ExportStreamError('cancelled', 'Export cancelled');
    }
    if (page.records.length === 0) return;

    for (const record of page.records) {
      yield record;
    }
    if (page.nextCursor === undefined) return;
    cursor = page.nextCursor;
  }
}

async function* createJsonChunks(
  options: CreateExportStreamOptions,
  signal: AbortSignal,
  assertWithinDuration: () => void,
  remainingBytes: () => number,
): AsyncGenerator<ExportChunk> {
  yield {
    record: false,
    text: `{\n  "exportedAt": ${JSON.stringify(options.exportedAt)},\n  "version": "1.0"`,
  };

  for (const source of options.sources) {
    yield { record: false, text: `,\n  ${JSON.stringify(source.name)}: [` };
    let first = true;
    for await (const record of readRecords(source, options.limits, signal, assertWithinDuration)) {
      assertRecordMayFit(record, remainingBytes());
      yield {
        record: true,
        text: `${first ? '\n' : ',\n'}${serializeJsonRecord(record)}`,
      };
      first = false;
    }
    yield { record: false, text: `${first ? '' : '\n'}  ]` };
  }

  yield { record: false, text: '\n}' };
}

async function* createCsvChunks(
  options: CreateExportStreamOptions,
  signal: AbortSignal,
  assertWithinDuration: () => void,
  remainingBytes: () => number,
): AsyncGenerator<ExportChunk> {
  const headers = options.csvHeaders ?? [];
  yield { record: false, text: headers.join(',') };

  const source = options.sources[0];
  if (!source) return;
  for await (const record of readRecords(source, options.limits, signal, assertWithinDuration)) {
    assertRecordMayFit(record, remainingBytes());
    yield {
      record: true,
      text: `\n${headers.map((header) => serializeCsvValue(record[header])).join(',')}`,
    };
  }
}

function toExportError(error: unknown): ExportStreamError {
  if (error instanceof ExportStreamError) return error;
  return new ExportStreamError(
    'serialization_error',
    'Export serialization failed',
    { cause: error },
  );
}

export function createExportStream(options: CreateExportStreamOptions): ReadableStream<Uint8Array> {
  const startedAt = Date.now();
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let bytes = 0;
  let records = 0;
  let finished = false;
  let iterator: AsyncGenerator<ExportChunk> | undefined;
  let pulling = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const finish = (outcome: ExportOutcome, errorCode?: ExportStreamErrorCode) => {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    options.requestSignal.removeEventListener('abort', handleRequestAbort);
    options.onFinish({
      bytes,
      durationMs: Date.now() - startedAt,
      errorCode,
      outcome,
      records,
    });
  };

  const handleRequestAbort = () => {
    const error = new ExportStreamError('cancelled', 'Export cancelled');
    abortController.abort(error);
    if (!pulling && streamController && !finished) {
      streamController.error(error);
      void iterator?.return(undefined);
      finish('cancelled', error.code);
    }
  };

  const assertWithinDuration = () => {
    if (Date.now() - startedAt >= options.limits.maxDurationMs) {
      throw new ExportStreamError('duration_limit', 'Export duration limit exceeded');
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      options.requestSignal.addEventListener('abort', handleRequestAbort, { once: true });
      if (options.requestSignal.aborted) handleRequestAbort();

      timeout = setTimeout(() => {
        const error = new ExportStreamError('duration_limit', 'Export duration limit exceeded');
        abortController.abort(error);
        if (!pulling) {
          controller.error(error);
          void iterator?.return(undefined);
          finish('failed', error.code);
        }
      }, options.limits.maxDurationMs);

      iterator = options.format === 'json'
        ? createJsonChunks(
            options,
            abortController.signal,
            assertWithinDuration,
            () => options.limits.maxBytes - bytes,
          )
        : createCsvChunks(
            options,
            abortController.signal,
            assertWithinDuration,
            () => options.limits.maxBytes - bytes,
          );
    },
    async pull(controller) {
      if (finished || !iterator) return;
      pulling = true;
      try {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        assertWithinDuration();

        const next = await iterator.next();
        if (next.done) {
          controller.close();
          finish('completed');
          return;
        }

        const chunk = encoder.encode(next.value.text);
        if (next.value.record && records >= options.limits.maxRecords) {
          throw new ExportStreamError('record_limit', 'Export record limit exceeded');
        }
        if (bytes + chunk.byteLength > options.limits.maxBytes) {
          throw new ExportStreamError('byte_limit', 'Export byte limit exceeded');
        }

        bytes += chunk.byteLength;
        if (next.value.record) records += 1;
        controller.enqueue(chunk);
      } catch (error) {
        const exportError = toExportError(error);
        controller.error(exportError);
        finish(exportError.code === 'cancelled' ? 'cancelled' : 'failed', exportError.code);
      } finally {
        pulling = false;
      }
    },
    async cancel() {
      abortController.abort(new ExportStreamError('cancelled', 'Export cancelled'));
      await iterator?.return(undefined);
      finish('cancelled', 'cancelled');
    },
  });
}
