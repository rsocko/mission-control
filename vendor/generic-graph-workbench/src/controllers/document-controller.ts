import {
  validateDocument,
  type GraphCommand,
  type GraphDocument,
  type ValidationResult
} from "../core/index.js";
import { GraphHistory } from "../core/index.js";
import {
  createHierarchyProjection,
  normalizedCollapsedNodeIds
} from "../layout/index.js";
import {
  isCommandBlockedByLayoutLock,
  GraphCommandController
} from "./command-history.js";
import { resolveNodeExpansion, resolveNodeReveal } from "./collapse.js";
import {
  repairHiddenGraphSelection,
  repairMissingGraphSelection,
  resolveClickNodeSelection,
  resolveMultiNodeSelection,
  type ClickNodeSelectionOptions,
  type GraphSelection,
  type MultiNodeSelectionOptions
} from "./selection.js";
import { resolveLayoutLockChange, resolveModeChange, type GraphInteractionMode } from "./mode.js";

export interface GraphDocumentSnapshot {
  readonly document: GraphDocument;
  readonly validation: ValidationResult;
  readonly selection: GraphSelection | undefined;
  readonly mode: GraphInteractionMode;
  readonly layoutLocked: boolean;
  readonly collapsedNodeIds: readonly string[];
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly isDirty: boolean;
  readonly lastError: string | undefined;
}

export interface GraphDocumentControllerOptions {
  selection?: GraphSelection;
  mode?: GraphInteractionMode;
  layoutLocked?: boolean;
  collapsedNodeIds?: readonly string[];
}

/**
 * Renderer-neutral, single-document controller composing selection, focus
 * mode/layout-lock, hierarchy collapse, command dispatch/undo/redo,
 * dirty-state, and (via {@link GraphDocumentController.navigate}) focus
 * navigation into one cohesive unit a host can drive without depending on
 * any particular renderer or persistence mechanism.
 *
 * Multi-document lifecycle, storage, onboarding, templates, and
 * generation/import are explicitly out of scope — hosts that need those
 * compose one controller instance per open document themselves.
 */
function freezeSnapshot(snapshot: GraphDocumentSnapshot): GraphDocumentSnapshot {
  const clone = structuredClone(snapshot);
  deepFreeze(clone, new WeakSet());
  return clone;
}

function deepFreeze(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child, visited);
  }
  Object.freeze(value);
}

export class GraphDocumentController {
  private readonly commands: GraphCommandController;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: GraphDocumentSnapshot;

  constructor(
    document: GraphDocument,
    options: GraphDocumentControllerOptions = {}
  ) {
    this.commands = new GraphCommandController(new GraphHistory(document));
    const currentDocument = this.commands.document;
    const collapsedNodeIds = normalizedCollapsedNodeIds(
      currentDocument,
      options.collapsedNodeIds ?? []
    );
    const selection = repairHiddenGraphSelection(
      repairMissingGraphSelection(options.selection, currentDocument),
      createHierarchyProjection(
        currentDocument,
        collapsedNodeIds
      ).hiddenByCollapsedNode
    );
    const layoutLocked = options.layoutLocked ?? false;
    this.snapshotValue = freezeSnapshot({
      document: currentDocument,
      validation: validateDocument(currentDocument),
      selection,
      mode: layoutLocked ? "hand" : (options.mode ?? "select"),
      layoutLocked,
      collapsedNodeIds,
      revision: this.commands.revision,
      canUndo: this.commands.canUndo,
      canRedo: this.commands.canRedo,
      isDirty: this.commands.isDirty,
      lastError: undefined
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns a frozen snapshot; runtime-safe against caller mutation (see {@link freezeSnapshot}). */
  readonly getSnapshot = (): GraphDocumentSnapshot => this.snapshotValue;

  private publish(patch: Partial<GraphDocumentSnapshot>): void {
    this.snapshotValue = freezeSnapshot({ ...this.snapshotValue, ...patch });
    for (const listener of this.listeners) listener();
  }

  select(selection: GraphSelection | undefined): void {
    this.publish({ selection, lastError: undefined });
  }

  selectNode(
    nodeId: string,
    availableNodeIds: ReadonlySet<string>,
    options: ClickNodeSelectionOptions = {}
  ): void {
    if (!availableNodeIds.has(nodeId)) {
      this.publish({ lastError: `Node not found: ${nodeId}` });
      return;
    }
    this.publish({
      selection: resolveClickNodeSelection(
        this.snapshotValue.selection,
        nodeId,
        availableNodeIds,
        options
      ),
      lastError: undefined
    });
  }

  selectNodes(
    nodeIds: readonly string[],
    availableNodeIds: ReadonlySet<string>,
    options: MultiNodeSelectionOptions = {}
  ): void {
    this.publish({
      selection: resolveMultiNodeSelection(
        this.snapshotValue.selection,
        nodeIds,
        availableNodeIds,
        options
      ),
      lastError: undefined
    });
  }

  setMode(mode: GraphInteractionMode): void {
    const next = resolveModeChange(this.snapshotValue, mode);
    if (next) this.publish({ mode: next, lastError: undefined });
  }

  setLayoutLocked(layoutLocked: boolean): void {
    this.publish({
      ...resolveLayoutLockChange(layoutLocked),
      lastError: undefined
    });
  }

  toggleHierarchy(nodeId: string): boolean {
    return this.setHierarchyExpanded(
      nodeId,
      this.snapshotValue.collapsedNodeIds.includes(nodeId)
    );
  }

  setHierarchyExpanded(nodeId: string, expanded: boolean): boolean {
    const result = resolveNodeExpansion(
      this.snapshotValue.document,
      this.snapshotValue.collapsedNodeIds,
      nodeId,
      expanded
    );
    if (!result) return false;
    const selection = repairHiddenGraphSelection(
      this.snapshotValue.selection,
      result.hierarchy.hiddenByCollapsedNode
    );
    this.publish({
      collapsedNodeIds: result.collapsedNodeIds,
      selection,
      lastError: undefined
    });
    return true;
  }

  revealNode(nodeId: string): boolean {
    const result = resolveNodeReveal(
      this.snapshotValue.document,
      this.snapshotValue.collapsedNodeIds,
      nodeId
    );
    if (!result) {
      this.publish({ lastError: `Node not found: ${nodeId}` });
      return false;
    }
    this.publish({
      collapsedNodeIds: result.collapsedNodeIds,
      selection: { kind: "node", id: nodeId },
      lastError: undefined
    });
    return true;
  }

  execute(commands: readonly GraphCommand[]): boolean {
    if (commands.length === 0) return true;
    if (
      this.snapshotValue.layoutLocked &&
      isCommandBlockedByLayoutLock(commands)
    ) {
      this.publish({
        lastError:
          "Layout is locked. Unlock it before moving nodes or changing relationships."
      });
      return false;
    }
    try {
      this.commitDocument(this.commands.execute(commands));
      return true;
    } catch (error) {
      this.publish({ lastError: describeError(error) });
      return false;
    }
  }

  undo(): void {
    if (!this.commands.canUndo) return;
    try {
      this.commitDocument(this.commands.undo());
    } catch (error) {
      this.publish({ lastError: describeError(error) });
    }
  }

  redo(): void {
    if (!this.commands.canRedo) return;
    try {
      this.commitDocument(this.commands.redo());
    } catch (error) {
      this.publish({ lastError: describeError(error) });
    }
  }

  /** Marks the current revision as persisted/clean (see {@link GraphDocumentSnapshot.isDirty}). */
  markClean(): void {
    this.commands.markClean();
    this.publish({ isDirty: this.commands.isDirty });
  }

  private commitDocument(document: GraphDocument): void {
    const collapsedNodeIds = normalizedCollapsedNodeIds(
      document,
      this.snapshotValue.collapsedNodeIds
    );
    const selection = repairHiddenGraphSelection(
      repairMissingGraphSelection(this.snapshotValue.selection, document),
      createHierarchyProjection(document, collapsedNodeIds).hiddenByCollapsedNode
    );
    this.publish({
      document,
      validation: validateDocument(document),
      revision: this.commands.revision,
      canUndo: this.commands.canUndo,
      canRedo: this.commands.canRedo,
      isDirty: this.commands.isDirty,
      collapsedNodeIds,
      selection,
      lastError: undefined
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
