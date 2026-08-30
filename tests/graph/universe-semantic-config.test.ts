import { afterEach, describe, expect, it } from 'vitest';
import {
  isUniverseClustersEnabled,
  isUniverseSemanticNeighborsEnabled,
} from '@/lib/graph/universe-semantic-config';

const originalValue = process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED;
const originalClusterValue = process.env.MC_UNIVERSE_CLUSTERS_ENABLED;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED;
  } else {
    process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED = originalValue;
  }
  if (originalClusterValue === undefined) {
    delete process.env.MC_UNIVERSE_CLUSTERS_ENABLED;
  } else {
    process.env.MC_UNIVERSE_CLUSTERS_ENABLED = originalClusterValue;
  }
});

describe('Universe cluster feature gate', () => {
  it('is independent and defaults on', () => {
    delete process.env.MC_UNIVERSE_CLUSTERS_ENABLED;
    expect(isUniverseClustersEnabled()).toBe(true);
    process.env.MC_UNIVERSE_CLUSTERS_ENABLED = 'off';
    expect(isUniverseClustersEnabled()).toBe(false);
    process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED = 'off';
    process.env.MC_UNIVERSE_CLUSTERS_ENABLED = 'true';
    expect(isUniverseClustersEnabled()).toBe(true);
  });
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
