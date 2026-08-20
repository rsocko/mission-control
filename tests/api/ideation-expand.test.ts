import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateIdeationExpansion, getResolvedAIConfig } = vi.hoisted(() => ({
  generateIdeationExpansion: vi.fn(),
  getResolvedAIConfig: vi.fn(() => ({ configured: true })),
}));

vi.mock('@/lib/ai/ideation-expand', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/ideation-expand')>();
  return { ...original, generateIdeationExpansion };
});

vi.mock('@/lib/ai/config-resolver', () => ({ getResolvedAIConfig }));
vi.mock('@/lib/logger', () => ({ default: { error: vi.fn() } }));

import { POST } from '@/app/api/ideation/expand/route';

const body = {
  selectedNode: { id: 'root', label: 'Build product', kind: 'idea', parentId: null },
  contextNodes: [
    { id: 'root', label: 'Build product', kind: 'idea', parentId: null, sortOrder: 0 },
  ],
  contextVersion: 'version-1',
};

function request(requestBody: unknown = body, headers: Record<string, string> = {}) {
  const request = new Request('http://localhost:3099/api/ideation/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(requestBody),
  });
  Object.defineProperty(request, 'headers', {
    value: new Headers({ 'Content-Type': 'application/json', ...headers }),
  });
  return request;
}

describe('POST /api/ideation/expand', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    generateIdeationExpansion.mockReset();
    generateIdeationExpansion.mockResolvedValue([
      { id: 'p1', label: 'Research', rationale: 'Learn.' },
      { id: 'p2', label: 'Prototype', rationale: 'Test.' },
      { id: 'p3', label: 'Launch', rationale: 'Ship.' },
    ]);
    getResolvedAIConfig.mockReturnValue({ configured: true });
  });

  it('requires a same-origin browser request or configured API key', async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request(body, {
      Origin: 'http://localhost:3099',
      'Sec-Fetch-Site': 'same-origin',
    }))).status).toBe(200);

    vi.stubEnv('MC_API_KEY', 'secret');
    expect((await POST(request(body, {
      Origin: 'http://localhost:3099',
      'Sec-Fetch-Site': 'same-origin',
    }))).status).toBe(401);
    const response = await POST(request(body, { 'X-MC-API-Key': 'secret' }));
    expect(response.status).toBe(200);
  });

  it('strictly validates bounded context before calling the model', async () => {
    vi.stubEnv('MC_API_KEY', 'secret');
    const response = await POST(request(
      { ...body, contextNodes: [] },
      { 'X-MC-API-Key': 'secret' },
    ));

    expect(response.status).toBe(400);
    expect(generateIdeationExpansion).not.toHaveBeenCalled();
  });

  it('rejects an oversized streamed body without relying on Content-Length', async () => {
    vi.stubEnv('MC_API_KEY', 'secret');
    const response = await POST(new Request('http://localhost:3099/api/ideation/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MC-API-Key': 'secret' },
      body: JSON.stringify({ ...body, padding: 'x'.repeat(17_000) }),
    }));

    expect(response.status).toBe(413);
    expect(generateIdeationExpansion).not.toHaveBeenCalled();
  });

  it('echoes context identity for client-side stale-response protection', async () => {
    vi.stubEnv('MC_API_KEY', 'secret');
    const response = await POST(request(
      body,
      { Authorization: 'Bearer secret' },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      selectedNodeId: 'root',
      contextVersion: 'version-1',
    }));
  });

  it('aborts stalled provider calls at the server deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MC_API_KEY', 'secret');
    generateIdeationExpansion.mockImplementation((_input, signal?: AbortSignal) => (
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason));
      })
    ));

    const responsePromise = POST(request(body, { 'X-MC-API-Key': 'secret' }));
    await vi.advanceTimersByTimeAsync(20_001);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: 'AI expansion timed out. Please retry.',
    });
    vi.useRealTimers();
  });

  it('distinguishes client cancellation from the server deadline', async () => {
    vi.stubEnv('MC_API_KEY', 'secret');
    generateIdeationExpansion.mockImplementation((_input, signal?: AbortSignal) => (
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason));
      })
    ));
    const controller = new AbortController();
    const cancellableRequest = new Request('http://localhost:3099/api/ideation/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MC-API-Key': 'secret' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responsePromise = POST(cancellableRequest);
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: 'Expansion cancelled' });
  });
});
