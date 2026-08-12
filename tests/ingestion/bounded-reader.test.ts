import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IngestionLimitError,
  IngestionTimeoutError,
  IngestionValidationError,
  readLimitedFile,
  readLimitedRequest,
  readLimitedResponse,
  readLimitedStream,
  timeoutSignal,
} from '@/lib/ingestion/bounded-reader';
import { fetchBounded } from '@/lib/ingestion/bounded-fetch';

function stream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('bounded ingestion readers', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(
      directory => rm(directory, { recursive: true, force: true }),
    ));
  });

  it('accepts exactly the configured byte boundary', async () => {
    await expect(readLimitedStream(stream(new Uint8Array([1, 2])), 2)).resolves.toHaveLength(2);
  });

  it('rejects chunked bodies that exceed the limit', async () => {
    await expect(readLimitedStream(stream(new Uint8Array([1]), new Uint8Array([2])), 1))
      .rejects.toBeInstanceOf(IngestionLimitError);
  });

  it('rejects spoofed declared lengths before reading', async () => {
    const response = new Response(stream(new Uint8Array([1])), {
      headers: { 'content-length': '99' },
    });
    await expect(readLimitedResponse(response, 2)).rejects.toBeInstanceOf(IngestionLimitError);
  });

  it('rejects an excessive declared request length before reading', async () => {
    const body = stream(new Uint8Array([1]));
    const request = {
      body,
      headers: new Headers({ 'content-length': '99' }),
      signal: new AbortController().signal,
    } as Request;

    await expect(readLimitedRequest(request, 2)).rejects.toBeInstanceOf(IngestionLimitError);
  });

  it('revalidates each redirect and rejects private destinations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/internal' },
    }));
    await expect(fetchBounded('https://93.184.216.34/document', {
      limit: 10,
      timeoutMs: 1000,
    })).rejects.toBeInstanceOf(IngestionValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects responses without a declared content type when restricted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream(new TextEncoder().encode('document')),
    } as unknown as Response);
    await expect(fetchBounded('https://example.com/document', {
      limit: 100,
      timeoutMs: 1000,
      acceptContentTypes: /^text\//,
    })).rejects.toBeInstanceOf(IngestionValidationError);
  });

  it('cancels a pending stream as soon as its signal is aborted', async () => {
    let cancelled = false;
    const pending = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const reading = readLimitedStream(pending, 10, { signal: controller.signal });

    controller.abort(new IngestionTimeoutError());

    await expect(reading).rejects.toBeInstanceOf(IngestionTimeoutError);
    expect(cancelled).toBe(true);
  });

  it('times out a slow source and releases its stream', async () => {
    let cancelled = false;
    const pending = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const timeout = timeoutSignal(5);

    try {
      await expect(readLimitedStream(pending, 10, { signal: timeout.signal }))
        .rejects.toBeInstanceOf(IngestionTimeoutError);
      expect(cancelled).toBe(true);
    } finally {
      timeout.cleanup();
    }
  });

  it('honors an already-aborted parent signal', () => {
    const parent = new AbortController();
    parent.abort(new IngestionTimeoutError());
    const timeout = timeoutSignal(1000, parent.signal);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBeInstanceOf(IngestionTimeoutError);
    timeout.cleanup();
  });

  it('reads files only from approved roots and enforces actual bytes', async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), 'mc-approved-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'mc-outside-'));
    temporaryDirectories.push(approvedRoot, outsideRoot);
    const approvedFile = join(approvedRoot, 'document.md');
    const outsideFile = join(outsideRoot, 'document.md');
    await writeFile(approvedFile, '12345');
    await writeFile(outsideFile, 'outside');

    await expect(readLimitedFile(approvedFile, 5, { approvedRoots: [approvedRoot] }))
      .resolves.toEqual(new TextEncoder().encode('12345'));
    await expect(readLimitedFile(approvedFile, 4, { approvedRoots: [approvedRoot] }))
      .rejects.toBeInstanceOf(IngestionLimitError);
    await expect(readLimitedFile(outsideFile, 100, { approvedRoots: [approvedRoot] }))
      .rejects.toBeInstanceOf(IngestionValidationError);
  });

  it('stops local file intake when cancellation is already requested', async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), 'mc-cancelled-file-'));
    temporaryDirectories.push(approvedRoot);
    const filePath = join(approvedRoot, 'document.md');
    await writeFile(filePath, 'document');
    const controller = new AbortController();
    controller.abort();

    await expect(readLimitedFile(filePath, 100, {
      approvedRoots: [approvedRoot],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
