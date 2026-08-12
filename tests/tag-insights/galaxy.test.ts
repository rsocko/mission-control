import { describe, expect, it } from 'vitest';
import {
  buildTagGalaxyData,
  filterTagInsights,
  fitTagGalaxyDisplayName,
  getTagGalaxyCollisionRadius,
  getTagGalaxyColor,
  getTagGalaxyDisplayName,
  getTagGalaxyLod,
  getTagGalaxyNodeRadius,
  TAG_GALAXY_EDGE_LIMIT,
  TAG_GALAXY_LINK_DISTANCE,
} from '@/lib/tag-insights/galaxy';
import type { TagInsights } from '@/lib/tag-insights/types';

const insights: TagInsights = {
  tags: [
    { id: 'backend', name: 'Backend', color: null, taskCount: 1, taskIds: ['1'] },
    { id: 'api', name: 'API', color: '#123456', taskCount: 2, taskIds: ['1', '2'] },
  ],
  pairs: [{
    key: '["api","backend"]',
    sourceTagId: 'api',
    targetTagId: 'backend',
    count: 1,
    taskIds: ['1'],
  }],
  tasks: {
    '1': { id: '1', title: 'Build endpoint', status: 'in_progress' },
    '2': { id: '2', title: 'Write contract', status: 'todo' },
  },
  meta: {
    topN: 15,
    minCooccurrence: 1,
    taskLimit: 2000,
    processedTaskCount: 2,
    truncated: false,
  },
};

describe('Tag Galaxy projection', () => {
  it('uses stable LOD thresholds for overview, labels, and task detail', () => {
    expect(getTagGalaxyLod(0.44)).toBe('overview');
    expect(getTagGalaxyLod(0.45)).toBe('labels');
    expect(getTagGalaxyLod(1.19)).toBe('labels');
    expect(getTagGalaxyLod(1.2)).toBe('detail');
  });

  it('keeps linked node circles separated and truncates long canvas labels', () => {
    const largestRadius = getTagGalaxyNodeRadius(Number.MAX_SAFE_INTEGER);

    expect(getTagGalaxyCollisionRadius({ taskCount: 1 }))
      .toBeGreaterThan(getTagGalaxyNodeRadius(1));
    expect(TAG_GALAXY_LINK_DISTANCE).toBeGreaterThan(largestRadius * 2);
    expect(getTagGalaxyDisplayName('Model Catalog & Organization'))
      .toBe('#Model Catalog…');
    expect(getTagGalaxyDisplayName('Model Catalog & Organization', 8))
      .toBe('#Model…');
    expect(getTagGalaxyDisplayName('#api')).toBe('#api');
    expect(fitTagGalaxyDisplayName('Model Catalog', 40, (text) => text.length * 10))
      .toBe('#Mo…');
    expect(fitTagGalaxyDisplayName('API', 40, (text) => text.length * 10))
      .toBe('#API');
  });

  it('builds a deterministic bounded graph and preserves pair provenance', () => {
    const first = buildTagGalaxyData(insights);
    const second = buildTagGalaxyData(insights);

    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.id)).toEqual(['api', 'backend']);
    expect(first.links[0]).toMatchObject({
      source: 'api',
      target: 'backend',
      count: 1,
      taskIds: ['1'],
    });
    expect(getTagGalaxyColor(insights.tags[1])).toBe('#123456');
    expect(getTagGalaxyColor(insights.tags[0])).toBe(getTagGalaxyColor(insights.tags[0]));
  });

  it('filters tags and relationships without changing the task dictionary', () => {
    const filtered = filterTagInsights(insights, 'api');

    expect(filtered.tags.map((tag) => tag.name)).toEqual(['API']);
    expect(filtered.pairs).toEqual([]);
    expect(filtered.tasks).toBe(insights.tasks);
  });

  it('defensively caps oversized relationship input', () => {
    const tags = Array.from({ length: 31 }, (_, index) => ({
      id: `tag-${index}`,
      name: `Tag ${index}`,
      color: null,
      taskCount: 1,
      taskIds: ['1'],
    }));
    const pairs = tags.flatMap((source, sourceIndex) => (
      tags.slice(sourceIndex + 1).map((target) => ({
        key: JSON.stringify([source.id, target.id]),
        sourceTagId: source.id,
        targetTagId: target.id,
        count: 1,
        taskIds: ['1'],
      }))
    ));

    const graph = buildTagGalaxyData({ ...insights, tags, pairs });

    expect(pairs.length).toBeGreaterThan(TAG_GALAXY_EDGE_LIMIT);
    expect(graph.links).toHaveLength(TAG_GALAXY_EDGE_LIMIT);
  });
});
