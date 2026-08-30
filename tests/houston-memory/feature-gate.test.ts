import { beforeEach, describe, expect, it, vi } from 'vitest';

const getResolvedAIConfig = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/config-resolver', () => ({ getResolvedAIConfig }));

import {
  getSemanticWorkerConfig,
  isSemanticEntityTypeEnabled,
} from '@/lib/semantic-index/config';

describe('Houston independent feature gate', () => {
  beforeEach(() => {
    getResolvedAIConfig.mockReturnValue({
      semanticSearchEnabled: false,
      houstonMemoryEnabled: true,
    });
  });

  it('limits maintenance to Houston without enabling other semantic corpora', () => {
    expect(getSemanticWorkerConfig().entityTypes).toEqual(['houston-summary']);
    expect(isSemanticEntityTypeEnabled('houston-summary')).toBe(true);
    expect(isSemanticEntityTypeEnabled('task')).toBe(false);
  });

  it('excludes Houston from the general semantic corpus when its own gate is off', () => {
    getResolvedAIConfig.mockReturnValue({
      semanticSearchEnabled: true,
      houstonMemoryEnabled: false,
    });
    expect(getSemanticWorkerConfig().entityTypes).not.toContain('houston-summary');
    expect(isSemanticEntityTypeEnabled('houston-summary')).toBe(false);
    expect(isSemanticEntityTypeEnabled('task')).toBe(true);
  });
});
