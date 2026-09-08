import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type {
  GraphHostCapabilities,
  GraphRenderSlots,
  GraphWorkbenchCapability
} from "../host/index.js";
import { hasWorkbenchCapability } from "./capability-gate.js";

export interface GraphWorkbenchRegionProps
  extends Omit<
    ComponentPropsWithoutRef<"section">,
    "role" | "children" | "aria-label"
  > {
  /** The workbench capability this region requires to render its content. */
  capability: GraphWorkbenchCapability;
  capabilities?: GraphHostCapabilities;
  renderSlots?: GraphRenderSlots;
  /** Accessible landmark role. Defaults to `"region"`. */
  role?: "region" | "complementary" | "form";
  /** Accessible name for the landmark (`aria-label`). */
  label: string;
  children: ReactNode;
}

/**
 * Establishes one accessible, capability-gated workbench landmark region.
 * When the host doesn't declare support for `capability`, renders
 * `renderSlots.renderEmptyState()` (if provided) instead of `children` — the
 * shared "no host renderer for this surface yet" fallback every workbench
 * region in this package uses.
 *
 * This is the base primitive `GraphCanvasRegion`, `GraphOutlineRegion`, and
 * `GraphInspectorRegion` specialize; product/experiment renderers compose
 * their real canvas/outline/inspector implementations as `children`.
 */
export function GraphWorkbenchRegion(
  props: GraphWorkbenchRegionProps
): ReactNode {
  const {
    capability,
    capabilities,
    renderSlots,
    role,
    label,
    children,
    ...rest
  } = props;
  const supported = hasWorkbenchCapability(capabilities, capability);
  return (
    <section
      {...rest}
      role={role ?? "region"}
      aria-label={label}
      data-workbench-capability={capability}
      data-workbench-capability-supported={supported}
    >
      {supported ? children : (renderSlots?.renderEmptyState?.() ?? null)}
    </section>
  );
}

export type GraphRegionProps = Omit<
  GraphWorkbenchRegionProps,
  "capability" | "role" | "label"
> & { label?: string };

export function GraphCanvasRegion(props: GraphRegionProps): ReactNode {
  return (
    <GraphWorkbenchRegion
      {...props}
      capability="canvas"
      label={props.label ?? "Canvas"}
    />
  );
}

export function GraphOutlineRegion(props: GraphRegionProps): ReactNode {
  return (
    <GraphWorkbenchRegion
      {...props}
      capability="outline"
      label={props.label ?? "Outline"}
    />
  );
}

export function GraphInspectorRegion(props: GraphRegionProps): ReactNode {
  return (
    <GraphWorkbenchRegion
      {...props}
      capability="select"
      role="complementary"
      label={props.label ?? "Inspector"}
    />
  );
}
