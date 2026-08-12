import { describe, expect, it } from 'vitest';
import {
  getConnectedFocus,
  getDescendantFocus,
  getSelectionFocus,
} from '@/lib/graph/focus';
import type { GraphEdge } from '@/lib/graph/types';

const edges: GraphEdge[] = [
  { id: 'project-phase', source: 'project:1', target: 'phase:1', type: 'contains', provenance: 'derived' },
  { id: 'phase-task-1', source: 'phase:1', target: 'task:1', type: 'contains', provenance: 'derived' },
  { id: 'phase-task-2', source: 'phase:1', target: 'task:2', type: 'contains', provenance: 'derived' },
  { id: 'task-blocks', source: 'task:1', target: 'task:2', type: 'blocks', provenance: 'explicit' },
  { id: 'unrelated', source: 'phase:2', target: 'task:3', type: 'contains', provenance: 'derived' },
];

describe('project graph focus', () => {
  it('finds every descendant through containment edges', () => {
    const focus = getDescendantFocus('project:1', edges);

    expect([...focus.nodeIds]).toEqual(['project:1', 'phase:1', 'task:1', 'task:2']);
    expect([...focus.edgeIds]).toEqual(['project-phase', 'phase-task-1', 'phase-task-2']);
  });

  it('does not treat dependency targets as descendants', () => {
    const focus = getDescendantFocus('task:1', edges);

    expect([...focus.nodeIds]).toEqual(['task:1']);
    expect([...focus.edgeIds]).toEqual([]);
  });

  it('previews every node and edge directly connected to a hovered node', () => {
    const focus = getConnectedFocus('task:1', edges);

    expect([...focus.nodeIds]).toEqual(['task:1', 'phase:1', 'task:2']);
    expect([...focus.edgeIds]).toEqual(['phase-task-1', 'task-blocks']);
  });

  it('focuses descendants and direct relationships without including grandparents', () => {
    const focus = getSelectionFocus('phase:1', edges);

    expect([...focus.nodeIds]).toEqual(['phase:1', 'task:1', 'task:2', 'project:1']);
    expect([...focus.edgeIds]).toEqual(['phase-task-1', 'phase-task-2', 'project-phase']);
  });

  it('focuses a task parent and its direct dependencies', () => {
    const focus = getSelectionFocus('task:1', edges);

    expect([...focus.nodeIds]).toEqual(['task:1', 'phase:1', 'task:2']);
    expect([...focus.edgeIds]).toEqual(['phase-task-1', 'task-blocks']);
  });
});
