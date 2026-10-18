import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  aiWarn: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('ai', () => ({
  generateText: mocks.generateText,
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  aiLogger: { error: vi.fn(), info: vi.fn(), warn: mocks.aiWarn },
  requestContext: { getStore: () => ({ traceId: '5af09a18-b67b-400e-ba2c-89d2cb837718' }) },
}));
vi.mock('@/lib/ai/provider-runtime', () => ({
  getAsyncAIProviderConfiguration: async () => ({ configured: true }),
  getAsyncAIModel: async () => ({
    model: { modelId: 'azure/gpt-4o-mini' },
    context: {
      featureId: 'project-phase-suggestion',
      sensitivity: 'standard',
      allowedRoutes: ['bifrost-copilot', 'ollama', 'azure-private', 'openai'],
      correlationId: '5af09a18-b67b-400e-ba2c-89d2cb837718',
    },
    configured: {
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
    },
  }),
  getAsyncAIRouteOutcome: vi.fn(),
}));
vi.mock('@/lib/projects/organization-service', () => ({
  getHubProject: async () => ({ id: 'proj-doc-intel', name: 'Document Intelligence' }),
  listPhasePlanningTaskIds: async () => ['task-1'],
  listPhasePlanningTasks: async () => [{
    id: 'task-1',
    title: 'Index documents',
    description: null,
    status: 'todo',
    priority: 'high',
    dueDate: null,
    connectorType: 'local',
    sourceListName: null,
    updatedAt: '2026-10-17T23:19:28.000Z',
    tags: [],
    projectNames: ['Document Intelligence'],
  }],
}));

import { POST } from '@/app/api/project-phases/ai-suggest/route';

describe('project phase AI provider errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps an upstream 429 to a retryable response without leaking provider details', async () => {
    mocks.generateText.mockRejectedValueOnce({
      name: 'AI_APICallError',
      message: '429 response contained secret-account@example.com',
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { 'retry-after': '45' },
      responseBody: '{"apiKey":"must-not-leak"}',
    });

    const response = await POST(new Request(
      'http://localhost/api/project-phases/ai-suggest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-doc-intel' }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(body).toEqual({
      error: 'The AI provider is temporarily rate limited. Try again shortly.',
      code: 'AI_RATE_LIMITED',
      traceId: '5af09a18-b67b-400e-ba2c-89d2cb837718',
      retryAfterSeconds: 45,
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('secret-account');
    expect(mocks.aiWarn).toHaveBeenCalledWith({
      event: 'ai_provider_request_failed',
      featureId: 'project-phase-suggestion',
      correlationId: '5af09a18-b67b-400e-ba2c-89d2cb837718',
      allowedRoutes: ['bifrost-copilot', 'ollama', 'azure-private', 'openai'],
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      errorCategory: 'rate_limit',
      upstreamStatus: 429,
      responseStatus: 429,
      retryAfterSeconds: 45,
    }, 'Retryable AI provider error');
    expect(JSON.stringify(mocks.aiWarn.mock.calls)).not.toContain('must-not-leak');
    expect(JSON.stringify(mocks.aiWarn.mock.calls)).not.toContain('secret-account');
  });

  it('classifies structured quota exhaustion separately from a generic rate limit', async () => {
    mocks.generateText.mockRejectedValueOnce({
      name: 'AI_APICallError',
      message: 'Provider request failed',
      statusCode: 429,
      isRetryable: true,
      data: {
        error: {
          code: 'insufficient_quota',
          message: 'Sensitive billing detail',
        },
      },
    });

    const response = await POST(new Request(
      'http://localhost/api/project-phases/ai-suggest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-doc-intel' }),
      },
    ));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({
      error: 'The AI provider quota is currently exhausted. Try again later or check the provider quota.',
      code: 'AI_QUOTA_EXHAUSTED',
      retryAfterSeconds: 60,
    });
    expect(mocks.aiWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'quota' }),
      'Retryable AI provider error',
    );
    expect(JSON.stringify(mocks.aiWarn.mock.calls)).not.toContain('Sensitive billing detail');
  });

  it('maps a retryable upstream outage to 503 with the provider retry hint', async () => {
    mocks.generateText.mockRejectedValueOnce({
      name: 'AI_APICallError',
      message: 'Service unavailable',
      statusCode: 503,
      isRetryable: true,
      responseHeaders: { 'retry-after': '12' },
    });

    const response = await POST(new Request(
      'http://localhost/api/project-phases/ai-suggest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-doc-intel' }),
      },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('12');
    await expect(response.json()).resolves.toMatchObject({
      error: 'The AI provider is temporarily unavailable. Try again shortly.',
      code: 'AI_PROVIDER_UNAVAILABLE',
      retryAfterSeconds: 12,
    });
    expect(mocks.aiWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCategory: 'provider_unavailable',
        upstreamStatus: 503,
        responseStatus: 503,
      }),
      'Retryable AI provider error',
    );
  });
});
