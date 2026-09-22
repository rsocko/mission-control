/**
 * Tests for PR #292 — Resolve source list display name at query time.
 *
 * Updated for L04: `buildSourceListNameMap` now reads through the portable
 * task-core `SourceListNameRepository` instead of a Drizzle handle, so the
 * test registers a fake composition rather than mocking `@/db`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SourceListDisplayNameRow,
  TaskCorePersistence,
} from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';

// Mock the display name resolver
vi.mock('@/lib/utils/source-list-display-name', () => ({
  resolveSourceListDisplayName: vi.fn((sl: { userDisplayName?: string | null; name: string }) =>
    sl.userDisplayName || sl.name
  ),
}));

const listSourceListDisplayNames = vi.fn<
  (ids: readonly string[]) => Promise<SourceListDisplayNameRow[]>
>();

function registerFake(): void {
  registerTaskCorePersistence({
    sourceListNames: { listSourceListDisplayNames },
  } as unknown as TaskCorePersistence);
}

describe('resolve-task-list-names utility (PR #292)', () => {
  beforeEach(() => {
    listSourceListDisplayNames.mockReset();
    listSourceListDisplayNames.mockResolvedValue([]);
    registerFake();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('resolveTaskListName should prefer map entry over stale sourceListName', async () => {
    const { resolveTaskListName } = await import('@/lib/utils/resolve-task-list-names');

    const map = new Map([['inst-1:list-A', 'Renamed List']]);
    const task = {
      sourceListId: 'list-A',
      connectorInstanceId: 'inst-1',
      sourceListName: 'Old Stale Name',
    };

    const result = resolveTaskListName(task, map);
    expect(result).toBe('Renamed List');
  });

  it('resolveTaskListName should fall back to sourceListName when no map entry', async () => {
    const { resolveTaskListName } = await import('@/lib/utils/resolve-task-list-names');

    const map = new Map<string, string>();
    const task = {
      sourceListId: 'list-B',
      connectorInstanceId: 'inst-2',
      sourceListName: 'Fallback Name',
    };

    const result = resolveTaskListName(task, map);
    expect(result).toBe('Fallback Name');
  });

  it('resolveTaskListName should return null when no sourceListId and no sourceListName', async () => {
    const { resolveTaskListName } = await import('@/lib/utils/resolve-task-list-names');

    const map = new Map<string, string>();
    const task = {
      sourceListId: null,
      connectorInstanceId: 'inst-1',
      sourceListName: null,
    };

    const result = resolveTaskListName(task, map);
    expect(result).toBeNull();
  });

  it('buildSourceListNameMap should return empty map without querying when no sourceListIds', async () => {
    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = await buildSourceListNameMap([
      { sourceListId: null, connectorInstanceId: 'inst-1' },
    ]);

    expect(result.size).toBe(0);
    expect(listSourceListDisplayNames).not.toHaveBeenCalled();
  });

  it('buildSourceListNameMap should use userDisplayName when available', async () => {
    listSourceListDisplayNames.mockResolvedValueOnce([
      { sourceId: 'list-1', connectorInstanceId: 'inst-1', name: 'Original', userDisplayName: 'User Renamed' },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = await buildSourceListNameMap([
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.get('inst-1:list-1')).toBe('User Renamed');
  });

  it('buildSourceListNameMap should fall back to name when userDisplayName is null', async () => {
    listSourceListDisplayNames.mockResolvedValueOnce([
      { sourceId: 'list-2', connectorInstanceId: 'inst-1', name: 'Default Name', userDisplayName: null },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = await buildSourceListNameMap([
      { sourceListId: 'list-2', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.get('inst-1:list-2')).toBe('Default Name');
  });

  it('buildSourceListNameMap should deduplicate sourceListIds before querying', async () => {
    listSourceListDisplayNames.mockResolvedValueOnce([
      { sourceId: 'list-1', connectorInstanceId: 'inst-1', name: 'Tasks', userDisplayName: null },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = await buildSourceListNameMap([
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.size).toBe(1);
    expect(listSourceListDisplayNames).toHaveBeenCalledWith(['list-1']);
  });
});
