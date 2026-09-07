import { GraphHistory, type GraphCommand, type GraphDocument } from "../core/index.js";

/** The exact historical Generic Graph Canvas layout-lock command gate. */
export const LAYOUT_LOCK_BLOCKED_COMMAND_TYPES: readonly GraphCommand["type"][] =
  [
    "set-placement",
    "set-placement-only",
    "create-relationship",
    "delete-relationship",
    "move-in-hierarchy"
  ];

export function isCommandBlockedByLayoutLock(
  commands: readonly GraphCommand[],
  blockedTypes: readonly GraphCommand["type"][] = LAYOUT_LOCK_BLOCKED_COMMAND_TYPES
): boolean {
  const blocked = new Set(blockedTypes);
  return commands.some((command) => blocked.has(command.type));
}

/**
 * Renderer-neutral command dispatch, undo/redo, and dirty-state tracking for
 * a single document. Wraps `GraphHistory` (`../core/index.js`) — the only
 * thing that may mutate the document — and adds a monotonic revision counter
 * so hosts can derive dirty-state (`isDirty`) relative to their own
 * last-persisted revision without re-deriving it from document equality.
 */
export class GraphCommandController {
  private historyValue: GraphHistory;
  private revisionValue: number;
  private cleanStateValue: object;

  constructor(
    history: GraphHistory,
    initialRevision = 0,
    cleanState = history.stateId
  ) {
    this.historyValue = history;
    this.revisionValue = initialRevision;
    this.cleanStateValue = cleanState;
  }

  get document(): GraphDocument {
    return this.historyValue.document;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get canUndo(): boolean {
    return this.historyValue.canUndo;
  }

  get canRedo(): boolean {
    return this.historyValue.canRedo;
  }

  /** True when the current history state differs from the last persisted state. */
  get isDirty(): boolean {
    return this.historyValue.stateId !== this.cleanStateValue;
  }

  execute(commands: readonly GraphCommand[]): GraphDocument {
    const previousState = this.historyValue.stateId;
    const document = this.historyValue.execute(commands);
    if (this.historyValue.stateId !== previousState) this.revisionValue += 1;
    return document;
  }

  undo(): GraphDocument {
    const document = this.historyValue.undo();
    this.revisionValue += 1;
    return document;
  }

  redo(): GraphDocument {
    const document = this.historyValue.redo();
    this.revisionValue += 1;
    return document;
  }

  /** Marks the current revision as persisted/clean. */
  markClean(): void {
    this.cleanStateValue = this.historyValue.stateId;
  }

  /**
   * Forks into an independent controller sharing no history state with this
   * one (mirrors `GraphHistory.fork()`), useful for speculative/preview
   * command batches a host may discard.
   */
  fork(): GraphCommandController {
    return new GraphCommandController(
      this.historyValue.fork(),
      this.revisionValue,
      this.cleanStateValue
    );
  }
}
