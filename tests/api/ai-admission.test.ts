import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireOllamaAdmission,
  resetAIAdmissionControllerForTests,
} from '@/lib/ai/admission-controller';

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock('@/lib/ai', () => ({
  getAIRouteOutcome: vi.fn(),
  getResolvedAIConfig: () => ({
    provider: 'ollama',
    model: 'llama3.1:8b',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    configured: true,
  }),
  streamChat: mocks.streamChat,
}));

vi.mock('@/lib/ai/context-budget', () => ({
  applyAIContextCharacterBudget: (value: string) => value,
  loadAIContextSnapshot: vi.fn(async () => ({
    counts: {
      open: 0,
      overdue: 0,
      dueToday: 0,
      inProgress: 0,
      critical: 0,
      unreadNotifications: 0,
      urgentNotifications: 0,
    },
    overdue: [],
    dueToday: [],
    inProgress: [],
    notifications: [],
    sources: [],
    rowCount: 0,
  })),
}));

vi.mock('@/lib/runtime/lifecycle', () => ({
  startRuntimeOperation: () => ({
    accepted: true,
    signal: new AbortController().signal,
    finish: mocks.finish,
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('POST /api/ai admission', () => {
  beforeEach(() => {
    vi.stubEnv('MC_AI_OLLAMA_CONCURRENCY', '1');
    vi.stubEnv('MC_AI_OLLAMA_QUEUE_LENGTH', '0');
    resetAIAdmissionControllerForTests();
    mocks.finish.mockClear();
    mocks.streamChat.mockClear();
  });

  afterEach(() => {
    resetAIAdmissionControllerForTests();
    vi.unstubAllEnvs();
  });

  it('returns a retryable response before opening a stream when capacity is full', async () => {
    const active = await acquireOllamaAdmission();
    const { POST } = await import('@/app/api/ai/route');
    const response = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What should I do next?' }],
      }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_CAPACITY_EXHAUSTED',
    });
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledOnce();
    active.release();
  }, 15_000);
});
