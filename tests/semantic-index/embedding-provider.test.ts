import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the embedding execution seam against a mocked shared request path.
 * The routing/credential logic itself lives in
 * `src/lib/search/embedding-request.ts` and is mocked here so these tests are
 * about *classification and sensitivity enforcement*, not about re-testing the
 * provider factory.
 */

const mocks = vi.hoisted(() => ({
  getEmbeddingConfig: vi.fn(),
  getConfiguredEmbeddingRoute: vi.fn(),
  requestEmbeddingResult: vi.fn(),
}));

vi.mock('@/lib/search/embedding-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/search/embedding-request')>()),
  getEmbeddingConfig: mocks.getEmbeddingConfig,
  getConfiguredEmbeddingRoute: mocks.getConfiguredEmbeddingRoute,
  requestEmbeddingResult: mocks.requestEmbeddingResult,
}));

import { AIRoutingDeniedError } from '@/lib/ai/sensitivity-policy';
import { AIEmbeddingProvider } from '@/lib/semantic-index/embedding-provider';
import { parseRetryAfter } from '@/lib/search/embedding-request';

function config(sensitivity: string, provider = 'openai') {
  return {
    provider,
    model: 'text-embedding-3-small',
    endpoint: 'https://example.test/embeddings',
    headers: {},
    context: {
      featureId: 'semantic-embedding',
      sensitivity,
      allowedRoutes: ['openai'],
      correlationId: 'corr-1',
    },
  };
}

const provider = new AIEmbeddingProvider();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEmbeddingConfig.mockResolvedValue(config('standard'));
  mocks.getConfiguredEmbeddingRoute.mockReturnValue({
    provider: 'openai',
    model: 'text-embedding-3-small',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AIEmbeddingProvider.embed', () => {
  it('returns a validated Float32Array with the resolved route', async () => {
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok',
      embedding: [0.1, 0.2, 0.3],
      provider: 'openai',
      model: 'text-embedding-3-small',
    });

    const result = await provider.embed({ text: 'hello', sensitivity: 'standard' });

    expect(result).toMatchObject({
      status: 'ok',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
    });
    expect(result.status === 'ok' && Array.from(result.embedding)).toHaveLength(3);
  });

  it('refuses empty text without contacting the provider', async () => {
    const result = await provider.embed({ text: '   ', sensitivity: 'standard' });
    expect(result).toMatchObject({ status: 'failed', reason: 'empty-text' });
    expect(mocks.requestEmbeddingResult).not.toHaveBeenCalled();
  });

  it('maps AIRoutingDeniedError from config resolution to denied', async () => {
    mocks.getEmbeddingConfig.mockRejectedValue(
      new AIRoutingDeniedError('openai', config('restricted').context as never),
    );
    const result = await provider.embed({ text: 'hello', sensitivity: 'restricted' });
    expect(result).toMatchObject({ status: 'denied', reason: 'routing-denied' });
    expect(mocks.requestEmbeddingResult).not.toHaveBeenCalled();
  });

  it('reports an unconfigured provider distinctly from a denial', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(null);
    const result = await provider.embed({ text: 'hello', sensitivity: 'standard' });
    expect(result).toMatchObject({ status: 'unconfigured' });
  });

  it('blocks local-only content before any egress', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(config('local-only', 'openai'));
    const result = await provider.embed({ text: 'secret', sensitivity: 'local-only' });
    expect(result).toMatchObject({ status: 'denied', reason: 'local-only-egress-blocked' });
    expect(mocks.requestEmbeddingResult).not.toHaveBeenCalled();
  });

  it('allows local-only content to reach the local route', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(config('local-only', 'ollama'));
    mocks.getConfiguredEmbeddingRoute.mockReturnValue({
      provider: 'ollama', model: 'nomic-embed-text',
    });
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0], provider: 'ollama', model: 'nomic-embed-text',
    });
    const result = await provider.embed({ text: 'secret', sensitivity: 'local-only' });
    expect(result.status).toBe('ok');
  });

  it('blocks local-only content when the responding route is not local', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(config('local-only', 'ollama'));
    mocks.getConfiguredEmbeddingRoute.mockReturnValue({
      provider: 'ollama', model: 'nomic-embed-text',
    });
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0], provider: 'openai', model: 'text-embedding-3-small',
    });
    const result = await provider.embed({ text: 'secret', sensitivity: 'local-only' });
    expect(result).toMatchObject({ status: 'denied', reason: 'local-only-egress-blocked' });
  });

  it('tightens the request context when the document is more restrictive', async () => {
    mocks.getEmbeddingConfig.mockResolvedValueOnce(config('standard'));
    mocks.getEmbeddingConfig.mockResolvedValueOnce(config('restricted', 'ollama'));
    mocks.getConfiguredEmbeddingRoute.mockReturnValue({
      provider: 'ollama', model: 'nomic-embed-text',
    });
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0], provider: 'ollama', model: 'nomic-embed-text',
    });

    await provider.embed({ text: 'hello', sensitivity: 'restricted', sources: ['finance'] });

    expect(mocks.getEmbeddingConfig).toHaveBeenNthCalledWith(1, ['finance']);
    expect(mocks.getEmbeddingConfig).toHaveBeenNthCalledWith(
      2, ['finance'], { sensitivityOverride: 'restricted' },
    );
  });

  it('does not attempt to relax a context that is already stricter', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(config('restricted', 'ollama'));
    mocks.getConfiguredEmbeddingRoute.mockReturnValue({
      provider: 'ollama', model: 'nomic-embed-text',
    });
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0], provider: 'ollama', model: 'nomic-embed-text',
    });

    await provider.embed({ text: 'hello', sensitivity: 'standard' });

    expect(mocks.getEmbeddingConfig).toHaveBeenCalledTimes(1);
  });

  it('propagates a retryable classification with the provider retry hint', async () => {
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'retryable',
      reason: 'http-429',
      retryAfter: '2026-08-29T00:01:00.000Z',
      httpStatus: 429,
    });
    const result = await provider.embed({ text: 'hello', sensitivity: 'standard' });
    expect(result).toMatchObject({
      status: 'retryable',
      reason: 'http-429',
      retryAfter: '2026-08-29T00:01:00.000Z',
    });
  });

  it('classifies a foreign route as an explicit failure, not a retry', async () => {
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0, 0], provider: 'azure', model: 'text-embedding-3-small',
    });
    const result = await provider.embed({
      text: 'hello',
      sensitivity: 'standard',
      expect: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'route-mismatch' });
  });

  it('classifies a dimension mismatch as an explicit failure', async () => {
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok', embedding: [1, 0], provider: 'openai', model: 'text-embedding-3-small',
    });
    const result = await provider.embed({
      text: 'hello',
      sensitivity: 'standard',
      expect: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'dimension-mismatch' });
  });

  it('rejects a non-finite embedding value', async () => {
    mocks.requestEmbeddingResult.mockResolvedValue({
      status: 'ok',
      embedding: [1, Number.NaN, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    const result = await provider.embed({ text: 'hello', sensitivity: 'standard' });
    expect(result).toMatchObject({ status: 'failed', reason: 'non-finite-embedding' });
  });

  it('reports an aborted signal without issuing a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await provider.embed({
      text: 'hello', sensitivity: 'standard', signal: controller.signal,
    });
    expect(result).toMatchObject({ status: 'aborted' });
    expect(mocks.requestEmbeddingResult).not.toHaveBeenCalled();
  });
});

describe('AIEmbeddingProvider.resolveRoute', () => {
  it('returns the configured route without embedding anything', async () => {
    const result = await provider.resolveRoute('standard');
    expect(result).toEqual({
      status: 'ok',
      route: { provider: 'openai', model: 'text-embedding-3-small' },
    });
    expect(mocks.requestEmbeddingResult).not.toHaveBeenCalled();
  });

  it('reports unconfigured and denied distinctly', async () => {
    mocks.getEmbeddingConfig.mockResolvedValueOnce(null);
    expect(await provider.resolveRoute('standard')).toMatchObject({ status: 'unconfigured' });

    mocks.getEmbeddingConfig.mockRejectedValueOnce(
      new AIRoutingDeniedError('openai', config('restricted').context as never),
    );
    expect(await provider.resolveRoute('restricted')).toMatchObject({ status: 'denied' });
  });

  it('refuses a non-local route for local-only work', async () => {
    mocks.getEmbeddingConfig.mockResolvedValue(config('local-only', 'openai'));
    expect(await provider.resolveRoute('local-only')).toMatchObject({
      status: 'denied', reason: 'local-only-egress-blocked',
    });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-29T00:00:00.000Z');

  it('accepts delta-seconds', () => {
    expect(parseRetryAfter('30', now)).toBe('2026-08-29T00:00:30.000Z');
  });

  it('accepts an HTTP date', () => {
    expect(parseRetryAfter('Sat, 29 Aug 2026 00:02:00 GMT', now))
      .toBe('2026-08-29T00:02:00.000Z');
  });

  it('clamps a past date to now', () => {
    expect(parseRetryAfter('Sat, 29 Aug 2020 00:00:00 GMT', now))
      .toBe('2026-08-29T00:00:00.000Z');
  });

  it('rejects absent, malformed, and hostile values', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('  ', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('999999', now)).toBeNull();
    expect(parseRetryAfter('Sat, 29 Aug 2099 00:00:00 GMT', now)).toBeNull();
  });
});
