import { afterEach, describe, expect, it } from 'vitest';
import { isUniverseSemanticNeighborsEnabled } from '@/lib/graph/universe-semantic-config';

const originalValue = process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED;
  } else {
    process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED = originalValue;
  }
});

describe('Universe semantic-neighbor feature gate', () => {
  it('is independently disabled by explicit false values', () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED = value;
      expect(isUniverseSemanticNeighborsEnabled()).toBe(false);
    }
  });

  it('defaults on and accepts explicit enablement', () => {
    delete process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED;
    expect(isUniverseSemanticNeighborsEnabled()).toBe(true);
    process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED = 'true';
    expect(isUniverseSemanticNeighborsEnabled()).toBe(true);
  });
});
