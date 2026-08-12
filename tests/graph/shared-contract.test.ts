import { describe, expect, it } from 'vitest';
import {
  boundGraph,
  canonicalPair,
  createSemanticSimilarityEdge,
  GraphQueryValidationError,
  normalizeGraphBudgets,
} from '@/lib/graph/query';
import { projectTagInsights, projectWordInsights } from '@/lib/graph/insight-projections';

describe('shared graph contract', () => {
  it('canonicalizes symmetric relationships without changing directional ones', () => {
    expect(canonicalPair('task:z', 'task:a')).toEqual(['task:a', 'task:z']);
    const edge = createSemanticSimilarityEdge({
      source: 'task:z',
      target: 'task:a',
      score: 0.82,
      embedding: {
        model: 'embedding-v1',
        sourceUpdatedAt: 'source-time',
        targetUpdatedAt: 'target-time',
      },
    });
    expect(edge).toMatchObject({
      source: 'task:a',
      target: 'task:z',
      provenance: 'embedding',
      score: 0.82,
      embedding: {
        model: 'embedding-v1',
        sourceUpdatedAt: 'target-time',
        targetUpdatedAt: 'source-time',
      },
    });
  });

  it.each([Number.NaN, -0.1, 1.01])(
    'rejects an invalid semantic similarity score: %s',
    (score) => {
      expect(() => createSemanticSimilarityEdge({
        source: 'task:a',
        target: 'task:b',
        score,
      })).toThrow(GraphQueryValidationError);
    },
  );

  it('applies node and edge budgets and reports each truncation reason', () => {
    const result = boundGraph(
      [
        { id: 'task:a', entityId: 'a', kind: 'task', label: 'A', status: 'todo' },
        { id: 'task:b', entityId: 'b', kind: 'task', label: 'B', status: 'todo' },
      ],
      [{
        id: 'related:a:b',
        source: 'task:a',
        target: 'task:b',
        type: 'related',
        provenance: 'explicit',
      }],
      { maxNodes: 1, maxEdges: 0, sourceTruncated: true },
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.pageInfo).toMatchObject({
      truncated: true,
      truncationReasons: ['node-limit', 'source-limit'],
    });
  });

  it('clamps valid budgets and rejects non-finite input', () => {
    expect(normalizeGraphBudgets({ maxNodes: 50_000, maxEdges: -5 })).toEqual({
      maxNodes: 1_000,
      maxEdges: 0,
    });
    expect(() => normalizeGraphBudgets({ maxNodes: Number.NaN })).toThrow(
      GraphQueryValidationError,
    );
  });
});

describe('specialized insight adapters', () => {
  it('preserves tag membership and exact co-occurrence provenance', () => {
    const graph = projectTagInsights({
      tags: [
        { id: 'a', name: 'A', color: null, taskCount: 1, taskIds: ['task-1'] },
        { id: 'b', name: 'B', color: null, taskCount: 1, taskIds: ['task-1'] },
      ],
      pairs: [{
        key: 'a:b',
        sourceTagId: 'b',
        targetTagId: 'a',
        count: 1,
        taskIds: ['task-1'],
      }],
      tasks: { 'task-1': { id: 'task-1', title: 'Task', status: 'todo' } },
      meta: {
        topN: 2,
        minCooccurrence: 1,
        taskLimit: 10,
        processedTaskCount: 1,
        truncated: false,
      },
    });
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'has-tag',
        provenance: 'derived',
        source: 'task:task-1',
      }),
      expect.objectContaining({
        type: 'tag-co-occurrence',
        source: 'tag:a',
        target: 'tag:b',
        count: 1,
        taskIds: ['task-1'],
      }),
    ]));
  });

  it('preserves word-to-task source attribution', () => {
    const graph = projectWordInsights({
      words: [{
        text: 'graph',
        count: 2,
        sources: { title: 1, tag: 1 },
        taskIds: ['task-1'],
        provenance: [{
          taskId: 'task-1',
          sources: [
            { source: 'title', count: 1, labels: ['Task title'] },
            { source: 'tag', count: 1, labels: ['Graph'] },
          ],
        }],
      }],
      tasks: [{ id: 'task-1', title: 'Graph task', status: 'todo', words: ['graph'] }],
      enabledSources: ['title', 'tag'],
      analyzedTaskCount: 1,
      truncated: false,
      totalWordCount: 1,
      wordTruncated: false,
      limits: {
        taskLimit: 10,
        wordLimit: 10,
        maxTextLength: 4_000,
        maxTokensPerValue: 64,
        maxValuesPerSourcePerTask: 32,
      },
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      type: 'word-task-provenance',
      provenance: 'derived',
      sources: [
        { source: 'title', count: 1, labels: ['Task title'] },
        { source: 'tag', count: 1, labels: ['Graph'] },
      ],
    }));
  });
});
