import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngestionTimeoutError } from '@/lib/ingestion/bounded-reader';

const previewIntakeAsync = vi.fn();
const executeIntake = vi.fn();
const parseDocumentAsync = vi.fn();

vi.mock('@/lib/intake/document-intake', () => ({
  previewIntakeAsync,
  executeIntake,
  parseDocumentAsync,
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  requestContext: { getStore: () => undefined },
}));

describe('POST /api/ai/intake-document budgets', () => {
  const originalApprovedRoots = process.env.MC_DOCUMENT_APPROVED_ROOTS;
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    previewIntakeAsync.mockResolvedValue({
      document: { findings: [], phases: [], priorityGroups: [], title: null },
      proposedProjectName: 'Document Intake',
      proposedPhases: [],
      proposedIssueCount: 0,
      proposedTags: [],
      parseMethod: 'deterministic',
    });
    parseDocumentAsync.mockResolvedValue({
      findings: [],
      phases: [],
      priorityGroups: [],
      title: null,
    });
    executeIntake.mockResolvedValue({
      dryRun: false,
      document: { findings: [], phases: [], priorityGroups: [], title: null },
      projectId: null,
      appendedToExisting: false,
      phases: [],
      issues: [],
      assignments: [],
      tags: [],
      errors: [],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.env.MC_DOCUMENT_APPROVED_ROOTS = originalApprovedRoots;
    await Promise.all(temporaryDirectories.splice(0).map(
      directory => rm(directory, { recursive: true, force: true }),
    ));
  });

  it('returns a stable 413 response when the actual request body exceeds its budget', async () => {
    const { POST } = await import('@/app/api/ai/intake-document/route');
    const response = await POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: 'x'.repeat(1_048_576) }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      error: expect.stringContaining('1048576-byte limit'),
    });
  });

  it('propagates client cancellation into downstream parsing', async () => {
    const controller = new AbortController();
    previewIntakeAsync.mockImplementation(
      (_content: string, config: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        config.signal.addEventListener('abort', () => reject(config.signal.reason), { once: true });
      }),
    );
    const { POST } = await import('@/app/api/ai/intake-document/route');
    const responsePromise = POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: '- task' }),
      signal: controller.signal,
    }));

    await vi.waitFor(() => expect(previewIntakeAsync).toHaveBeenCalledOnce());
    controller.abort(new IngestionTimeoutError());

    const response = await responsePromise;
    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INGESTION_TIMEOUT',
      error: 'Document ingestion timed out',
    });
  });

  it('returns 408 when the configured processing timeout expires', async () => {
    vi.useFakeTimers();
    previewIntakeAsync.mockImplementation(
      (_content: string, config: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        config.signal.addEventListener('abort', () => reject(config.signal.reason), { once: true });
      }),
    );
    const { POST } = await import('@/app/api/ai/intake-document/route');
    const responsePromise = POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: '- task' }),
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(previewIntakeAsync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);

    const response = await responsePromise;
    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INGESTION_TIMEOUT',
      error: 'Document ingestion timed out',
    });
  });

  it('returns validation without exposing an unapproved local path', async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), 'mc-route-approved-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'mc-route-outside-'));
    temporaryDirectories.push(approvedRoot, outsideRoot);
    process.env.MC_DOCUMENT_APPROVED_ROOTS = approvedRoot;
    const outsideFile = join(outsideRoot, 'private.md');
    await writeFile(outsideFile, '- private task');
    const { POST } = await import('@/app/api/ai/intake-document/route');

    const response = await POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: outsideFile }),
    }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'File path is outside the approved document roots',
    });
    expect(JSON.stringify(body)).not.toContain(outsideFile);
  });

  it('returns 413 for an oversized approved local document without exposing its path', async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), 'mc-route-large-file-'));
    temporaryDirectories.push(approvedRoot);
    process.env.MC_DOCUMENT_APPROVED_ROOTS = approvedRoot;
    const filePath = join(approvedRoot, 'large.md');
    await writeFile(filePath, Buffer.alloc(5_242_881));
    const { POST } = await import('@/app/api/ai/intake-document/route');

    const response = await POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath }),
    }));

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      error: expect.stringContaining('5242880-byte limit'),
    });
    expect(JSON.stringify(body)).not.toContain(filePath);
  });

  it('finishes bounded parsing before execute-mode mutations begin', async () => {
    const parsedDocument = {
      findings: [],
      phases: [],
      priorityGroups: [],
      title: 'Prepared',
    };
    parseDocumentAsync.mockResolvedValueOnce(parsedDocument);
    const { POST } = await import('@/app/api/ai/intake-document/route');

    const response = await POST(new Request('http://localhost/api/ai/intake-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        document: '- task',
        mode: 'execute',
        repo: 'owner/repo',
      }),
    }));

    expect(response.status).toBe(200);
    expect(parseDocumentAsync).toHaveBeenCalledWith('- task', expect.any(AbortSignal));
    expect(executeIntake).toHaveBeenCalledWith('- task', expect.objectContaining({
      parsedDocument,
    }));
    expect(executeIntake.mock.calls[0][1]).not.toHaveProperty('signal');
  });
});
