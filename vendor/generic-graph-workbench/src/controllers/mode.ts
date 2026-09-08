export type GraphInteractionMode = "select" | "hand" | "connect";

export interface GraphModeState {
  mode: GraphInteractionMode;
  layoutLocked: boolean;
}

/**
 * Resolves whether a requested interaction-mode change is allowed. Returns
 * `undefined` when the change is a no-op or blocked (e.g. a locked layout
 * cannot enter "connect" mode, since connecting nodes can move them).
 */
export function resolveModeChange(
  state: GraphModeState,
  nextMode: GraphInteractionMode
): GraphInteractionMode | undefined {
  if (state.layoutLocked && nextMode === "connect") return undefined;
  if (state.mode === nextMode) return undefined;
  return nextMode;
}

export interface LayoutLockChange {
  layoutLocked: boolean;
  mode?: "hand";
}

/**
 * Resolves the state change for locking/unlocking the layout. Locking always
 * forces interaction mode to "hand" (selecting/connecting could otherwise
 * move nodes while the layout is meant to be frozen).
 */
export function resolveLayoutLockChange(layoutLocked: boolean): LayoutLockChange {
  return layoutLocked ? { layoutLocked, mode: "hand" } : { layoutLocked };
}
