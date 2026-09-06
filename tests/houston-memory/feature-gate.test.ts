import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadAIProviderConfiguration = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration,
}));

describe('Houston independent feature gate', () => {
  beforeEach(() => {
    vi.resetModules();
    loadAIProviderConfiguration.mockResolvedValue({
      resolved: {
        semanticSearchEnabled: false,
        houstonMemoryEnabled: true,
      },
      routingPolicy: {
        policies: {},
        featureDefaults: {},
        sourceDefaults: {},
      },
    });
  });

  it('limits maintenance to Houston without enabling other semantic corpora', async () => {
    const {
      getSemanticWorkerConfig,
      isSemanticEntityTypeEnabled,
      loadSemanticIndexConfiguration,
    } = await import('@/lib/semantic-index/config');
    await loadSemanticIndexConfiguration();
    expect(getSemanticWorkerConfig().entityTypes).toEqual(['houston-summary']);
    expect(isSemanticEntityTypeEnabled('houston-summary')).toBe(true);
    expect(isSemanticEntityTypeEnabled('task')).toBe(false);
  });

  it('excludes Houston from the general semantic corpus when its own gate is off', async () => {
    loadAIProviderConfiguration.mockResolvedValue({
      resolved: {
        semanticSearchEnabled: true,
        houstonMemoryEnabled: false,
      },
      routingPolicy: {
        policies: {},
        featureDefaults: {},
        sourceDefaults: {},
      },
    });
    const {
      getSemanticWorkerConfig,
      isSemanticEntityTypeEnabled,
      loadSemanticIndexConfiguration,
    } = await import('@/lib/semantic-index/config');
    await loadSemanticIndexConfiguration();
    expect(getSemanticWorkerConfig().entityTypes).not.toContain('houston-summary');
    expect(isSemanticEntityTypeEnabled('houston-summary')).toBe(false);
    expect(isSemanticEntityTypeEnabled('task')).toBe(true);
  });
});
