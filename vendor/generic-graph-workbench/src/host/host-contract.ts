import type { ReactNode } from "react";
import type {
  Diagnostic,
  GraphCommand,
  GraphDocument,
  GraphNode,
  GraphRelationship,
  GraphView,
  ProfileId
} from "../core/index.js";

export const GRAPH_WORKBENCH_CAPABILITIES = [
  "canvas",
  "outline",
  "source",
  "table",
  "select",
  "arrange",
  "connect",
  "saved-views",
  "semantic-mutations",
  "view-mutations"
] as const;

export type GraphWorkbenchCapability =
  (typeof GRAPH_WORKBENCH_CAPABILITIES)[number];

export type GraphHostSnapshot<T> =
  T extends (...arguments_: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly GraphHostSnapshot<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: GraphHostSnapshot<T[Key]> }
        : T;

export interface GraphHostCapabilities {
  supported: ReadonlySet<GraphWorkbenchCapability>;
  profileIds: readonly ProfileId[];
}

export interface GraphHostContext {
  documentId: string;
  viewId: string;
  revision: string;
}

export type GraphCommandAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface GraphHostPolicy {
  authorize(
    commands: GraphHostSnapshot<readonly GraphCommand[]>,
    context: GraphHostContext
  ): GraphCommandAuthorization | Promise<GraphCommandAuthorization>;
}

export interface GraphDocumentRevision {
  document: GraphHostSnapshot<GraphDocument>;
  revision: string;
}

export interface GraphSaveRequest {
  document: GraphHostSnapshot<GraphDocument>;
  expectedRevision: string;
  /**
   * The identifier `load()` was called with. Persistence ports must save to
   * this location, not to `document.document.id` (a domain identifier that
   * does not necessarily match where the document should be stored - e.g.
   * the desktop host's absolute `.gwb` file path is chosen independently via
   * an Open/Save dialog and can differ from the document's own id).
   */
  documentId: string;
}

export type GraphLoadResult =
  | { status: "loaded"; value: GraphDocumentRevision }
  | { status: "not-found" };

export type GraphSaveResult =
  | { status: "saved"; revision: string }
  | { status: "conflict"; current: GraphDocumentRevision }
  | { status: "rejected"; diagnostics: readonly Diagnostic[] };

export interface GraphPersistencePort {
  load(
    documentId: string,
    signal?: AbortSignal
  ): Promise<GraphLoadResult>;
  save(
    request: GraphSaveRequest,
    signal?: AbortSignal
  ): Promise<GraphSaveResult>;
}

export interface GraphProjectionRequest {
  graphId: string;
  viewId?: string;
}

export type GraphProjectionResult =
  | { status: "loaded"; value: GraphDocumentRevision }
  | { status: "not-found" }
  | { status: "rejected"; diagnostics: readonly Diagnostic[] };

export interface GraphProjectionSource {
  load(
    request: GraphProjectionRequest,
    signal?: AbortSignal
  ): Promise<GraphProjectionResult>;
}

export interface GraphMutationRequest {
  context: GraphHostContext;
  commands: GraphHostSnapshot<readonly GraphCommand[]>;
}

export type GraphMutationResult =
  | { status: "applied"; value: GraphDocumentRevision }
  | { status: "conflict"; current: GraphDocumentRevision }
  | { status: "rejected"; diagnostics: readonly Diagnostic[] };

export interface GraphMutationPort {
  apply(
    request: GraphMutationRequest,
    signal?: AbortSignal
  ): Promise<GraphMutationResult>;
}

export type GraphHostDataBoundary =
  | {
      kind: "authored-document";
      persistence: GraphPersistencePort;
    }
  | {
      kind: "domain-projection";
      source: GraphProjectionSource;
      mutations: GraphMutationPort;
    };

export type GraphPersistenceStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

export interface GraphHostDiagnostic {
  code: string;
  message: string;
  severity: "info" | Diagnostic["severity"];
  operation: string;
  documentId?: string;
  viewId?: string;
}

export interface GraphDiagnosticSink {
  report(diagnostic: GraphHostDiagnostic): void;
}

export interface GraphNodeRendererProps {
  document: GraphHostSnapshot<GraphDocument>;
  node: GraphHostSnapshot<GraphNode>;
  view: GraphHostSnapshot<GraphView>;
  selected: boolean;
  focused: boolean;
  disabled: boolean;
}

export interface GraphRelationshipRendererProps {
  document: GraphHostSnapshot<GraphDocument>;
  relationship: GraphHostSnapshot<GraphRelationship>;
  view: GraphHostSnapshot<GraphView>;
  selected: boolean;
  focused: boolean;
  disabled: boolean;
}

export type GraphHostSelection =
  | {
      kind: "node";
      primaryId: string;
      ids: readonly string[];
    }
  | { kind: "property"; nodeId: string; key: string }
  | { kind: "relationship"; id: string }
  | { kind: "none" };

export interface GraphRenderSlots {
  renderNode?(props: GraphNodeRendererProps): ReactNode;
  renderRelationship?(props: GraphRelationshipRendererProps): ReactNode;
  renderInspectorHeader?(selection: GraphHostSelection): ReactNode;
  renderEmptyState?(): ReactNode;
  renderPersistenceStatus?(status: GraphPersistenceStatus): ReactNode;
}

export interface GraphHostAdapter {
  id: string;
  capabilities: GraphHostCapabilities;
  policy: GraphHostPolicy;
  data: GraphHostDataBoundary;
  diagnostics: GraphDiagnosticSink;
  renderSlots?: GraphRenderSlots;
}

export function defineGraphHostAdapter(
  adapter: GraphHostAdapter
): GraphHostAdapter {
  return adapter;
}
