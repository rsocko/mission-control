/**
 * `@rsocko/generic-graph-canvas-shared-workbench/react` — capability-gated
 * workbench composition and Canvas/Outline/Inspector primitives with host
 * render-slot support. Deliberately excludes browser/desktop persistence,
 * document library UI, onboarding, templates, and other Generic-product
 * concerns: product renderers compose *through* these primitives (as
 * `children`) rather than this package reimplementing them.
 */
export * from "./capability-gate.js";
export * from "./region.js";
