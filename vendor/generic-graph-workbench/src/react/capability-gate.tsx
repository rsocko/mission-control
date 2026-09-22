import type { ReactNode } from "react";
import type {
  GraphHostCapabilities,
  GraphWorkbenchCapability
} from "../host/index.js";

/**
 * True when `capabilities` (if provided) declares support for `capability`.
 * A `undefined` capabilities set is treated as "unconstrained" so components
 * work standalone (outside a host) without every caller having to construct
 * a permissive `GraphHostCapabilities` value.
 */
export function hasWorkbenchCapability(
  capabilities: GraphHostCapabilities | undefined,
  capability: GraphWorkbenchCapability
): boolean {
  return capabilities === undefined || capabilities.supported.has(capability);
}

export interface CapabilityGateProps {
  capabilities?: GraphHostCapabilities;
  capability: GraphWorkbenchCapability;
  /** Rendered when the capability is not supported. Defaults to `null`. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Renders `children` only when the host declares support for `capability`,
 * otherwise renders `fallback` (or nothing). This is the primitive every
 * capability-gated workbench region in this package builds on.
 */
export function CapabilityGate(props: CapabilityGateProps): ReactNode {
  return hasWorkbenchCapability(props.capabilities, props.capability)
    ? props.children
    : (props.fallback ?? null);
}
