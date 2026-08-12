import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_UNIVERSE_DIMENSIONS,
  type UniverseDimension,
} from '@/lib/graph/universe-types';
import type { LegacyUniverseFilters } from '@/lib/task-filter-context';

interface UniverseGraphState {
  dimensions: UniverseDimension[];
  legacyFilters: LegacyUniverseFilters | null;
  selectedNodeIds: string[];
  toggleDimension: (dimension: UniverseDimension) => void;
  clearLegacyFilters: () => void;
  setSelectedNodeIds: (nodeIds: Iterable<string>) => void;
  resetScene: () => void;
  reconcileSelection: (visibleNodeIds: Iterable<string>) => void;
}

export function migrateUniverseGraphState(
  persisted: unknown,
  version: number,
): Pick<UniverseGraphState, 'dimensions' | 'legacyFilters'> {
  const state = isRecord(persisted) ? persisted : {};
  const dimensions = Array.isArray(state.dimensions)
    ? state.dimensions as UniverseDimension[]
    : [...DEFAULT_UNIVERSE_DIMENSIONS];
  if (version >= 2) {
    return {
      dimensions,
      legacyFilters: isRecord(state.legacyFilters) ? state.legacyFilters : null,
    };
  }
  return {
    dimensions,
    legacyFilters: {
      search: state.search,
      priorities: state.priorities,
      statuses: state.statuses,
      sources: state.sources,
      lists: state.lists,
    },
  };
}

export const useUniverseGraphStore = create<UniverseGraphState>()(
  persist(
    (set) => ({
      dimensions: [...DEFAULT_UNIVERSE_DIMENSIONS],
      legacyFilters: null,
      selectedNodeIds: [],
      toggleDimension: (dimension) => set((state) => {
        const active = state.dimensions.includes(dimension);
        if (active && state.dimensions.length === 1) return state;
        return {
          dimensions: active
            ? state.dimensions.filter((candidate) => candidate !== dimension)
            : [...state.dimensions, dimension],
        };
      }),
      clearLegacyFilters: () => set({ legacyFilters: null }),
      setSelectedNodeIds: (nodeIds) => set({
        selectedNodeIds: [...new Set(nodeIds)],
      }),
      // Canonical filter/dimension fetches intentionally clear transient selection.
      resetScene: () => set({
        selectedNodeIds: [],
      }),
      reconcileSelection: (visibleNodeIds) => set((state) => {
        const visible = new Set(visibleNodeIds);
        const selectedNodeIds = state.selectedNodeIds.filter((nodeId) => visible.has(nodeId));
        return sameIds(selectedNodeIds, state.selectedNodeIds) ? state : { selectedNodeIds };
      }),
    }),
    {
      name: 'mission-control:universe-graph',
      version: 2,
      migrate: migrateUniverseGraphState,
      partialize: (state) => ({
        dimensions: state.dimensions,
      }),
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
