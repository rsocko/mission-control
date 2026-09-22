import {
  GraphFocusHistory,
  type GraphFocusLocation
} from "../layout/index.js";

export type GraphNavigationDirection = "back" | "forward";

/**
 * Renderer-neutral coordination around `GraphFocusHistory`
 * (`../layout/index.js`): a single place to record focus transitions and
 * step back/forward through them, so a host only needs one direction-aware
 * `navigate` call instead of duplicating the back/forward branch at each
 * call site.
 */
export class GraphNavigationController {
  private readonly focusHistory = new GraphFocusHistory();

  visit(
    key: string,
    current: GraphFocusLocation,
    destination: GraphFocusLocation
  ): void {
    this.focusHistory.visit(key, current, destination);
  }

  navigate(
    key: string,
    direction: GraphNavigationDirection,
    current: GraphFocusLocation
  ): GraphFocusLocation | undefined {
    return direction === "back"
      ? this.focusHistory.back(key, current)
      : this.focusHistory.forward(key, current);
  }

  canNavigate(key: string, direction: GraphNavigationDirection): boolean {
    return direction === "back"
      ? this.focusHistory.canBack(key)
      : this.focusHistory.canForward(key);
  }

  replaceCurrent(
    key: string,
    expectedNodeId: string | undefined,
    location: GraphFocusLocation
  ): boolean {
    return this.focusHistory.replaceCurrent(key, expectedNodeId, location);
  }

  reconcile(key: string, nodeIds: ReadonlySet<string>): void {
    this.focusHistory.reconcile(key, nodeIds);
  }
}

export type { GraphFocusLocation };
