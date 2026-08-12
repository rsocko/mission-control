import { NextResponse } from 'next/server';
import { withRuntimeOperation } from '@/lib/telemetry/operations';
import AdmZip from 'adm-zip';
import { importTwitterArchive, importAllTwitterArchive } from '@/lib/triage/importers';
import { identifyArchiveFile } from '@/lib/triage/importers/twitter-archive-importer';
import type { TwitterArchiveFile } from '@/lib/triage/importers';
import logger from '@/lib/logger';
import { startRuntimeOperation } from '@/lib/runtime/lifecycle';

const DEFAULT_MAX_REQUEST_BYTES = 129 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_COUNT = 10_000;
const DEFAULT_MAX_ENTRY_EXPANDED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_REQUEST_BYTES = 512 * 1024 * 1024;
const MAX_CONFIGURED_ENTRY_COUNT = 100_000;
const MAX_CONFIGURED_ENTRY_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_CONFIGURED_TOTAL_EXPANDED_BYTES = 512 * 1024 * 1024;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);

export interface TwitterArchiveLimits {
  maxRequestBytes: number;
  maxEntryCount: number;
  maxEntryExpandedBytes: number;
  maxTotalExpandedBytes: number;
}

class ArchiveValidationError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
  }
}

function configuredPositiveInteger(name: string, fallback: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export function getTwitterArchiveLimits(): TwitterArchiveLimits {
  return {
    maxRequestBytes: configuredPositiveInteger(
      'MC_TWITTER_ARCHIVE_MAX_REQUEST_BYTES',
      DEFAULT_MAX_REQUEST_BYTES,
      MAX_CONFIGURED_REQUEST_BYTES,
    ),
    maxEntryCount: configuredPositiveInteger(
      'MC_TWITTER_ARCHIVE_MAX_ENTRY_COUNT',
      DEFAULT_MAX_ENTRY_COUNT,
      MAX_CONFIGURED_ENTRY_COUNT,
    ),
    maxEntryExpandedBytes: configuredPositiveInteger(
      'MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES',
      DEFAULT_MAX_ENTRY_EXPANDED_BYTES,
      MAX_CONFIGURED_ENTRY_EXPANDED_BYTES,
    ),
    maxTotalExpandedBytes: configuredPositiveInteger(
      'MC_TWITTER_ARCHIVE_MAX_TOTAL_EXPANDED_BYTES',
      DEFAULT_MAX_TOTAL_EXPANDED_BYTES,
      MAX_CONFIGURED_TOTAL_EXPANDED_BYTES,
    ),
  };
}

function validateEntryPath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0')
    || segments.some((segment) => segment === '..' || segment === '.')
  ) {
    throw new ArchiveValidationError('Archive contains an unsafe entry path', 400);
  }
  return normalized;
}

function isSymlink(entry: AdmZip.IZipEntry): boolean {
  return ((entry.attr >>> 16) & 0xf000) === 0xa000;
}

/**
 * Extracts the `data/*.js` entries this importer understands (tweet, like,
 * account) from an uploaded X/Twitter archive ZIP, skipping media and any
 * other unrelated files to keep memory usage bounded.
 */
function extractRelevantFiles(
  zipBuffer: Buffer,
  signal: AbortSignal,
  limits: TwitterArchiveLimits,
): TwitterArchiveFile[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new ArchiveValidationError('Uploaded archive is not a valid ZIP file', 400);
  }
  let entries: AdmZip.IZipEntry[];
  try {
    entries = zip.getEntries();
  } catch {
    throw new ArchiveValidationError('Uploaded archive is not a valid ZIP file', 400);
  }
  if (entries.length > limits.maxEntryCount) {
    throw new ArchiveValidationError('Archive contains too many entries', 413);
  }

  const relevantEntries: Array<{ entry: AdmZip.IZipEntry; path: string }> = [];
  let declaredExpandedBytes = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    const path = validateEntryPath(entry.entryName);
    const header = entry.header;
    if ((header.flags & 0x1) !== 0 || header.encrypted || isSymlink(entry)) {
      throw new ArchiveValidationError('Archive contains an unsupported entry', 400);
    }
    if (!SUPPORTED_COMPRESSION_METHODS.has(header.method)) {
      throw new ArchiveValidationError('Archive contains an unsupported compression method', 400);
    }
    if (
      !Number.isSafeInteger(header.size)
      || header.size < 0
      || !Number.isSafeInteger(header.compressedSize)
      || header.compressedSize < 0
    ) {
      throw new ArchiveValidationError('Archive contains invalid entry metadata', 400);
    }
    if (entry.isDirectory) continue;

    if (identifyArchiveFile(path)) {
      if (header.size > limits.maxEntryExpandedBytes) {
        throw new ArchiveValidationError('Archive entry exceeds the expanded size limit', 413);
      }
      if (header.method === 0 && header.compressedSize !== header.size) {
        throw new ArchiveValidationError('Archive contains invalid entry metadata', 400);
      }
      declaredExpandedBytes += header.size;
      if (declaredExpandedBytes > limits.maxTotalExpandedBytes) {
        throw new ArchiveValidationError('Archive expanded data exceeds the total size limit', 413);
      }
      relevantEntries.push({ entry, path });
    }
  }

  const files: TwitterArchiveFile[] = [];
  let extractedBytes = 0;
  for (const { entry, path } of relevantEntries) {
    signal.throwIfAborted();
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new ArchiveValidationError('Uploaded archive is not a valid ZIP file', 400);
    }
    extractedBytes += data.byteLength;
    if (data.byteLength > limits.maxEntryExpandedBytes) {
      throw new ArchiveValidationError('Archive entry exceeds the expanded size limit', 413);
    }
    if (extractedBytes > limits.maxTotalExpandedBytes) {
      throw new ArchiveValidationError('Archive expanded data exceeds the total size limit', 413);
    }
    files.push({
      path,
      contents: data.toString('utf-8'),
    });
  }

  return files;
}

async function importArchive(request: Request) {
  const runtimeOperation = startRuntimeOperation('archive-import');
  if (!runtimeOperation.accepted) {
    return NextResponse.json(
      { error: 'Service is draining' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }
  const limits = getTwitterArchiveLimits();
  const requestSignal = request.signal;
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, runtimeOperation.signal])
    : runtimeOperation.signal;
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limits.maxRequestBytes) {
      return NextResponse.json({ error: 'Archive exceeds the 128MB upload limit' }, { status: 413 });
    }
    const reader = request.body?.getReader();
    if (!reader) {
      return NextResponse.json(
        { error: 'Upload a Twitter/X archive ZIP as multipart form field "file"' },
        { status: 400 },
      );
    }
    const cancelReader = () => {
      void reader.cancel(signal.reason);
    };
    signal.addEventListener('abort', cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let requestBytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        requestBytes += value.byteLength;
        if (requestBytes > limits.maxRequestBytes) {
          await reader.cancel();
          return NextResponse.json(
            { error: 'Archive exceeds the 128MB upload limit' },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', cancelReader);
    }
    signal.throwIfAborted();
    const body = new Uint8Array(requestBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const formData = await new Request(request.url, {
      method: 'POST',
      headers,
      body: body.buffer,
    }).formData().catch(() => null);
    const file = formData?.get('file');

    if (!file || typeof file === 'string') {
      return NextResponse.json(
        { error: 'Upload a Twitter/X archive ZIP as multipart form field "file"' },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength > limits.maxRequestBytes) {
      return NextResponse.json({ error: 'Archive exceeds the 128MB upload limit' }, { status: 413 });
    }

    const zipBuffer = Buffer.from(arrayBuffer);
    const files = extractRelevantFiles(zipBuffer, signal, limits);

    if (!files.length) {
      return NextResponse.json(
        { error: 'No data/tweet.js, data/like.js, or data/account.js entries found in the uploaded archive' },
        { status: 400 },
      );
    }

    const mode = (formData?.get('mode') as string | null) || 'single';

    if (mode === 'full' || mode === 'incremental') {
      const result = await importAllTwitterArchive({
        files,
        signal,
      });
      return NextResponse.json({ result, mode });
    }

    const summary = await importTwitterArchive({
      files,
      signal,
    });
    return NextResponse.json({ summary });
  } catch (error) {
    if (signal.aborted) {
      return NextResponse.json(
        { error: 'Service is draining' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
    if (error instanceof ArchiveValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error }, 'Failed to import Twitter/X archive');
    return NextResponse.json({ error: 'Failed to import Twitter/X archive' }, { status: 500 });
  } finally {
    runtimeOperation.finish();
  }
}

export function POST(request: Request) {
  return withRuntimeOperation({
    kind: 'import',
    name: 'twitter-archive',
    traceId: request.headers.get('x-trace-id') ?? undefined,
    routeFamily: '/api/triage/import/twitter-archive',
  }, () => importArchive(request));
}
