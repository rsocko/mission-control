/**
 * `@rsocko/generic-graph-canvas-shared-workbench/host` — the typed,
 * deeply-readonly host adapter contract and `defineGraphHostAdapter`. Host
 * callbacks only ever observe `GraphHostSnapshot<T>` (deeply-readonly)
 * projections and can never bypass command validation, history, or
 * dirty-state handling owned by `./controllers` and `./core`.
 */
export * from "./host-contract.js";
