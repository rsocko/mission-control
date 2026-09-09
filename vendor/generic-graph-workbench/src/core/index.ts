/**
 * `@rsocko/generic-graph-canvas-shared-workbench/core` — neutral graph
 * document/type definitions, command application, undo/redo history,
 * schema validation, and profile contracts/helpers.
 *
 * This is the canonical source for these modules. `experiments/computing/
 * generic-graph-canvas/spike/src/{types,commands,history,validation,
 * profiles}.ts` are thin re-export compatibility shims over this package for
 * other experiments/tooling that still resolve those legacy paths; adapters
 * (markdown/json-canvas/mermaid) and fixtures remain in the spike and import
 * this package directly rather than duplicating it.
 */
export * from "./commands.js";
export * from "./history.js";
export * from "./profiles.js";
export * from "./types.js";
export * from "./validation.js";
