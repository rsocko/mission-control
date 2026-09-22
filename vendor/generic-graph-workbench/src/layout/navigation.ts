import type { CanvasViewport } from "./viewport.js";

export interface GraphFocusLocation {
  nodeId: string | undefined;
  viewport: CanvasViewport;
}

interface HistoryState {
  entries: GraphFocusLocation[];
  index: number;
}

export class GraphFocusHistory {
  private readonly states = new Map<string, HistoryState>();

  visit(
    key: string,
    current: GraphFocusLocation,
    destination: GraphFocusLocation
  ): void {
    const state = this.states.get(key) ?? {
      entries: [copyLocation(current)],
      index: 0
    };
    state.entries[state.index] = copyLocation(current);
    if (!locationsEqual(current, destination)) {
      state.entries.splice(state.index + 1);
      state.entries.push(copyLocation(destination));
      state.index += 1;
    }
    this.states.set(key, state);
  }

  back(
    key: string,
    current: GraphFocusLocation
  ): GraphFocusLocation | undefined {
    const state = this.states.get(key);
    if (!state || state.index === 0) return undefined;
    state.entries[state.index] = copyLocation(current);
    state.index -= 1;
    return copyLocation(state.entries[state.index]!);
  }

  forward(
    key: string,
    current: GraphFocusLocation
  ): GraphFocusLocation | undefined {
    const state = this.states.get(key);
    if (!state || state.index >= state.entries.length - 1) return undefined;
    state.entries[state.index] = copyLocation(current);
    state.index += 1;
    return copyLocation(state.entries[state.index]!);
  }

  canBack(key: string): boolean {
    return (this.states.get(key)?.index ?? 0) > 0;
  }

  canForward(key: string): boolean {
    const state = this.states.get(key);
    return Boolean(state && state.index < state.entries.length - 1);
  }

  replaceCurrent(
    key: string,
    expectedNodeId: string | undefined,
    location: GraphFocusLocation
  ): boolean {
    const state = this.states.get(key);
    if (!state || state.entries[state.index]?.nodeId !== expectedNodeId) {
      return false;
    }
    state.entries[state.index] = copyLocation(location);
    return true;
  }

  reconcile(key: string, nodeIds: ReadonlySet<string>): void {
    const state = this.states.get(key);
    if (!state) return;
    const previousEntries = state.entries;
    const previousIndex = state.index;
    const current = state.entries[state.index];
    const entries = state.entries.filter(
      (entry) => entry.nodeId === undefined || nodeIds.has(entry.nodeId)
    );
    if (entries.length === 0) {
      this.states.delete(key);
      return;
    }
    state.entries = entries;
    state.index = current ? entries.indexOf(current) : -1;
    if (state.index < 0) {
      const validBeforeCurrent = previousEntries
        .slice(0, previousIndex)
        .filter(
          (entry) => entry.nodeId === undefined || nodeIds.has(entry.nodeId)
        ).length;
      state.index = Math.max(0, validBeforeCurrent - 1);
    }
  }
}

function copyLocation(location: GraphFocusLocation): GraphFocusLocation {
  return {
    nodeId: location.nodeId,
    viewport: { ...location.viewport }
  };
}

function locationsEqual(
  left: GraphFocusLocation,
  right: GraphFocusLocation
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.viewport.x === right.viewport.x &&
    left.viewport.y === right.viewport.y &&
    left.viewport.zoom === right.viewport.zoom
  );
}
