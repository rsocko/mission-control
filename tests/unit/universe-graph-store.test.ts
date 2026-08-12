import { beforeEach, describe, expect, it } from 'vitest';
import {
  migrateUniverseGraphState,
  useUniverseGraphStore,
} from '@/lib/stores/universeGraphStore';
import { migrateLegacyUniverseFilters } from '@/lib/task-filter-context';

describe('Universe graph persistence migration', () => {
  it('separates legacy dataset filters from persisted presentation dimensions', () => {
    const migratedState = migrateUniverseGraphState({
      dimensions: ['tags', 'project'],
      search: 'release',
      priorities: ['high'],
      statuses: ['todo'],
      sources: ['github-issues'],
      lists: ['work:repo'],
    }, 0);

    expect(migratedState.dimensions).toEqual(['tags', 'project']);
    expect(migrateLegacyUniverseFilters(migratedState.legacyFilters ?? {}).context).toMatchObject({
      query: 'release',
      priorities: ['high'],
      statuses: ['todo'],
      sources: ['github-issues'],
      listIds: ['work:repo'],
    });

    expect(migratedState).not.toHaveProperty('priorities');
    expect(migratedState).not.toHaveProperty('search');
  });

  describe('Universe graph scene state', () => {
    beforeEach(() => {
      useUniverseGraphStore.setState({
        selectedNodeIds: [],
      });
    });

    it('resets selection for a new canonical graph', () => {
      useUniverseGraphStore.getState().setSelectedNodeIds(['task:1']);
      useUniverseGraphStore.getState().resetScene();
      expect(useUniverseGraphStore.getState().selectedNodeIds).toEqual([]);
    });

    it('reconciles selection when nodes leave the canonical graph', () => {
      useUniverseGraphStore.getState().setSelectedNodeIds(['task:1', 'task:2']);
      useUniverseGraphStore.getState().reconcileSelection(['task:2', 'task:3']);
      expect(useUniverseGraphStore.getState().selectedNodeIds).toEqual(['task:2']);
    });
  });
});
