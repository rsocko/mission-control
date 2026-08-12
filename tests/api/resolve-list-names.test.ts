/**
 * Tests for PR #292 — Resolve source list display name at query time
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => {
  const mockAll = vi.fn(() => []);
  return {
    default: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ all: mockAll })),
          all: mockAll,
        })),
      })),
    },
    __mockAll: mockAll,
  };
});

vi.mock('@/db/schema', () => ({
  sourceLists: {
    sourceId: 'source_id',
    connectorInstanceId: 'connector_instance_id',
    name: 'name',
    userDisplayName: 'user_display_name',
  },
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })),
}));

// Mock the display name resolver
vi.mock('@/lib/utils/source-list-display-name', () => ({
  resolveSourceListDisplayName: vi.fn((sl: { userDisplayName?: string | null; name: string }) =>
    sl.userDisplayName || sl.name
  ),
}));

describe('resolve-task-list-names utility (PR #292)', () => {
  beforeEach(() => {
    vi.resetModules();
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

  it('buildSourceListNameMap should return empty map when no sourceListIds', async () => {
    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = buildSourceListNameMap([
      { sourceListId: null, connectorInstanceId: 'inst-1' },
    ]);

    expect(result.size).toBe(0);
  });

  it('buildSourceListNameMap should use userDisplayName when available', async () => {
    // Re-mock to return source list rows
    const db = await import('@/db');
    const mockAll = (db as unknown as { __mockAll: ReturnType<typeof vi.fn> }).__mockAll;
    mockAll.mockReturnValueOnce([
      { sourceId: 'list-1', connectorInstanceId: 'inst-1', name: 'Original', userDisplayName: 'User Renamed' },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = buildSourceListNameMap([
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.get('inst-1:list-1')).toBe('User Renamed');
  });

  it('buildSourceListNameMap should fall back to name when userDisplayName is null', async () => {
    const db = await import('@/db');
    const mockAll = (db as unknown as { __mockAll: ReturnType<typeof vi.fn> }).__mockAll;
    mockAll.mockReturnValueOnce([
      { sourceId: 'list-2', connectorInstanceId: 'inst-1', name: 'Default Name', userDisplayName: null },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = buildSourceListNameMap([
      { sourceListId: 'list-2', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.get('inst-1:list-2')).toBe('Default Name');
  });

  it('buildSourceListNameMap should deduplicate sourceListIds', async () => {
    const db = await import('@/db');
    const mockAll = (db as unknown as { __mockAll: ReturnType<typeof vi.fn> }).__mockAll;
    mockAll.mockReturnValueOnce([
      { sourceId: 'list-1', connectorInstanceId: 'inst-1', name: 'Tasks', userDisplayName: null },
    ]);

    const { buildSourceListNameMap } = await import('@/lib/utils/resolve-task-list-names');

    const result = buildSourceListNameMap([
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
      { sourceListId: 'list-1', connectorInstanceId: 'inst-1' },
    ]);

    expect(result.size).toBe(1);
  });
});
