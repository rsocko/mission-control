import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeProjectHierarchyCommand,
  ProjectHierarchyUndoTracker,
} from '@/lib/projects/hierarchy-client';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('project hierarchy client', () => {
  it('reuses the command ID when retrying a transport failure', async () => {
    const result = {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      hierarchy: {
        projectId: 'project-1',
        revision: 1,
        phases: [],
        phaseItemsByPhase: {},
      },
      inverseCommand: {
        type: 'reorder_phases' as const,
        orderedPhaseIds: ['phase-1'],
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(executeProjectHierarchyCommand({
      projectId: 'project-1',
      expectedRevision: 0,
      commandId: result.commandId,
      command: {
        type: 'reorder_phases',
        orderedPhaseIds: ['phase-1'],
      },
    })).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(firstBody.commandId).toBe(result.commandId);
    expect(secondBody).toEqual(firstBody);
  });

  it('advances earlier inverse commands after undoing in LIFO order', () => {
    const tracker = new ProjectHierarchyUndoTracker();
    tracker.push('command-a', 1);
    tracker.push('command-b', 2);

    expect(tracker.expectedRevision('command-b')).toBe(2);
    tracker.complete('command-b', 3);

    expect(tracker.expectedRevision('command-a')).toBe(3);
  });

  it('rejects undoing an older command before newer hierarchy changes', () => {
    const tracker = new ProjectHierarchyUndoTracker();
    tracker.push('command-a', 1);
    tracker.push('command-b', 2);

    expect(() => tracker.expectedRevision('command-a'))
      .toThrow('Undo newer project hierarchy changes first');
  });

  it('returns attached undo entry IDs when invalidating tracked commands', () => {
    const tracker = new ProjectHierarchyUndoTracker();
    tracker.push('command-a', 1);
    tracker.attachUndoEntry('command-a', 'undo-a');
    tracker.push('command-b', 2);
    tracker.attachUndoEntry('command-b', 'undo-b');

    expect(tracker.clear()).toEqual(['undo-a', 'undo-b']);
    expect(tracker.validationError('command-b')).toBe(
      'Undo newer project hierarchy changes first',
    );
  });
});
