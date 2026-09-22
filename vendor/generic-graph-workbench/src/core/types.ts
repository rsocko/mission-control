export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProfileId = string;
/**
 * A simple, user-facing orientation/alignment choice for hierarchy-shaped
 * layouts: `balanced` splits children across both sides of a root
 * (mind-map style), while the rest grow the tree toward one side.
 */
export type GraphLayoutOrientation =
  | "balanced"
  | "top-down"
  | "bottom-up"
  | "left-to-right"
  | "right-to-left";
export type ViewType = "canvas" | "outline" | "source" | "table";
export type GraphTheme =
  | "cyberpunk"
  | "dracula"
  | "focus"
  | "forest"
  | "midnight"
  | "nord"
  | "paper"
  | "rainbow"
  | "rose-pine"
  | "solarized"
  | "synthwave";
export type GraphColorStrategy = "branch-spectrum" | "semantic";
export type NodeAppearanceAccent =
  | "blue"
  | "cyan"
  | "green"
  | "neutral"
  | "orange"
  | "purple"
  | "red"
  | "yellow";
export type NodeAppearanceFill = "accent" | "gradient" | "solid" | "tinted";
export type NodeAppearanceShape =
  | "capsule"
  | "circle"
  | "cut-corner"
  | "cylinder"
  | "diamond"
  | "document"
  | "fallback"
  | "oval"
  | "parallelogram"
  | "rectangle"
  | "rounded";
export type NodeAppearanceSize =
  | "auto"
  | "content"
  | "large"
  | "medium"
  | "small"
  | "tiny";
export type NodeAppearanceTextScale = "compact" | "large" | "regular";
export type VisualRuleTarget = "node" | "relationship";
export type VisualRuleOperator =
  | "equals"
  | "not-equals"
  | "greater-than"
  | "greater-than-or-equal"
  | "less-than"
  | "less-than-or-equal"
  | "exists";
export type VisualRuleComparisonOperator = Exclude<
  VisualRuleOperator,
  "exists"
>;
export type SupplementaryVisualIcon =
  | "alert"
  | "blocked"
  | "check"
  | "clock"
  | "progress"
  | "trend-up";

export type VisualRuleCondition =
  | {
      property: string;
      operator: "exists";
      value?: never;
    }
  | {
      property: string;
      operator: VisualRuleComparisonOperator;
      value: JsonPrimitive;
    };

export interface SupplementaryIconEncoding {
  name: SupplementaryVisualIcon;
  label: string;
}

export interface SupplementaryTextEncoding {
  property: string;
  label: string;
}

export interface SupplementaryBarEncoding {
  property: string;
  label: string;
  minimum: number;
  maximum: number;
}

export type SupplementaryBadgeEncoding =
  | {
      label: string;
      property: string;
      text?: never;
    }
  | {
      label: string;
      property?: never;
      text: string;
    };

interface VisualRuleChannels {
  accent?: NodeAppearanceAccent;
  icon?: SupplementaryIconEncoding;
  text?: SupplementaryTextEncoding;
  bar?: SupplementaryBarEncoding;
  badge?: SupplementaryBadgeEncoding;
}

export type VisualRuleOutput = VisualRuleChannels &
  (
    | { icon: SupplementaryIconEncoding }
    | { text: SupplementaryTextEncoding }
    | { bar: SupplementaryBarEncoding }
    | { badge: SupplementaryBadgeEncoding }
  );

export interface VisualEncodingRule {
  id: string;
  target: VisualRuleTarget;
  entityTypes?: string[];
  when: VisualRuleCondition;
  apply: VisualRuleOutput;
}
export type RelationshipLinePattern = "solid" | "dashed" | "dotted";
export type RelationshipEndpointMarker =
  | "none"
  | "arrow"
  | "bar"
  | "circle"
  | "diamond";
export type RelationshipRouteKind = "straight" | "curved" | "elbow";

export interface NodeAppearance {
  accent?: NodeAppearanceAccent;
  fill?: NodeAppearanceFill;
  maxWidth?: number;
  shape?: NodeAppearanceShape;
  size?: NodeAppearanceSize;
  textScale?: NodeAppearanceTextScale;
}

export interface RelationshipAppearance {
  linePattern?: RelationshipLinePattern;
  sourceMarker?: RelationshipEndpointMarker;
  targetMarker?: RelationshipEndpointMarker;
}

export interface GraphViewAppearance {
  colorStrategy?: GraphColorStrategy;
  theme?: GraphTheme;
  showNodeIcon?: boolean;
  showNodeType?: boolean;
  showRelationshipIcon?: boolean;
  showRelationshipLabel?: boolean;
  nodeDefaults?: NodeAppearance;
  nodeTypeStyles?: Record<string, NodeAppearance>;
  visualRules?: VisualEncodingRule[];
  nodeVisualOverrides?: Record<string, VisualRuleOutput>;
  relationshipVisualOverrides?: Record<string, VisualRuleOutput>;
  relationshipTypeStyles?: Record<string, RelationshipAppearance>;
}

export interface DocumentMetadata {
  id: string;
  title: string;
  profile: ProfileId;
}

export interface ExternalReference {
  system: string;
  id: string;
  url?: string;
}

export const ICON_PICKER_SOURCES = [
  "emoji",
  "lucide",
  "mdi",
  "ph",
  "dash",
  "si"
] as const;
export type IconPickerSource = (typeof ICON_PICKER_SOURCES)[number];

export interface IconPickerResource {
  id: string;
  kind: "icon-picker";
  contractVersion: number;
  value: string;
  fallbackText: string;
  label?: string;
}

export type MediaResourceSource =
  | { kind: "relative-file"; path: string }
  | { kind: "host"; reference: string }
  | { kind: "embedded"; data: string };

export interface MediaResource {
  id: string;
  kind: "media";
  contractVersion: number;
  mediaType: string;
  altText: string;
  width?: number;
  height?: number;
  checksum?: string;
  source: MediaResourceSource;
}

export type GraphResource = IconPickerResource | MediaResource;
export type RichCardSectionKind =
  | "architecture"
  | "network"
  | "erd"
  | "uml-overview"
  | "journey";

export interface RichCardRow {
  label: string;
  value: string;
}

export interface RichCardSection {
  kind: RichCardSectionKind;
  title: string;
  rows: RichCardRow[];
}

export interface RichCard {
  iconResourceId?: string;
  mediaResourceId?: string;
  sections: RichCardSection[];
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  /**
   * Optional sanitized Markdown content for this node, rendered (not raw
   * HTML) separately from `label`. Bounded to `MARKDOWN_LIMITS.bodyLength`
   * characters; see `schema/graph-document-v1.schema.json`.
   */
  body?: string;
  card?: RichCard;
  properties: Record<string, JsonValue>;
  externalReferences?: ExternalReference[];
  extensions?: Record<string, JsonValue>;
}

export interface RelationshipProvenance {
  kind: "user" | "imported" | "inferred" | "ai-proposed";
  source?: string;
}

export interface GraphRelationship {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, JsonValue>;
  provenance?: RelationshipProvenance;
  extensions?: Record<string, JsonValue>;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed?: boolean;
  appearance?: NodeAppearance;
  style?: Record<string, JsonValue>;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewAxisValue {
  value: JsonPrimitive;
  label: string;
}

export interface ViewAxis {
  id: string;
  label: string;
  orientation: "horizontal" | "vertical";
  scale: "categorical" | "temporal";
  values: ViewAxisValue[];
  propertyKey?: string;
}

export type ViewRegionLayoutStrategy =
  | "tree"
  | "timeline"
  | "matrix"
  | "fishbone";

export interface ViewRegionLayout {
  strategy: ViewRegionLayoutStrategy;
  direction?: "horizontal" | "vertical";
  axisIds?: string[];
  rootId?: string;
  spacing?: number;
}

export interface ViewRegion {
  id: string;
  label: string;
  kind: "container" | "lane" | "column" | "cell";
  bounds: ViewBounds;
  axisValues?: Record<string, JsonPrimitive>;
  layout?: ViewRegionLayout;
}

export interface ViewNodeMapping {
  regionIds: string[];
  axisValues?: Record<string, JsonPrimitive>;
}

export interface GraphViewStructure {
  axes: ViewAxis[];
  regions: ViewRegion[];
  nodeMappings: Record<string, ViewNodeMapping>;
}

export interface RoutePoint {
  x: number;
  y: number;
}

export type RelationshipRoute =
  | { kind: "straight" | "curved" | "elbow" }
  | { kind: "manual"; waypoints: RoutePoint[] };

export interface GraphView {
  id: string;
  type: ViewType;
  name: string;
  placements: Record<string, Placement>;
  routes?: Record<string, RelationshipRoute>;
  visibleProperties: string[];
  preferredLayout?: {
    strategy: string;
    requiredCapabilities: string[];
  };
  requiredCapabilities?: string[];
  structure?: GraphViewStructure;
  appearance?: GraphViewAppearance;
  extensions?: Record<string, JsonValue>;
}

export interface GraphDocument {
  format: "generic-graph-document";
  version: 1;
  document: DocumentMetadata;
  resources?: GraphResource[];
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  views: GraphView[];
  extensions?: Record<string, JsonValue>;
}

export type ConnectionSide = "top" | "right" | "bottom" | "left";

export interface GraphProfile {
  id: ProfileId;
  version: number;
  name: string;
  description: string;
  nodeTypes: readonly string[];
  relationshipTypes: readonly string[];
  hierarchyRelationship?: string;
  hierarchyConstraints?: ProfileHierarchyConstraints;
  defaultRelationshipType?: string;
  relationshipTypeByTargetSide?: Partial<Record<ConnectionSide, string>>;
  defaultVisibleProperties: readonly string[];
  propertyDefinitions: readonly PropertyDefinition[];
  nodeTypeDefinitions: readonly ProfileNodeTypeDefinition[];
  relationshipTypeDefinitions: readonly ProfileRelationshipTypeDefinition[];
  customProperties?: ProfileCustomPropertyScopes;
  /**
   * Profile-wide fallback display-label property, used only for
   * relationship types that don't declare their own
   * `ProfileRelationshipTypeDefinition.displayLabelProperty`. Prefer
   * declaring `displayLabelProperty` on the specific relationship type(s)
   * that need a custom label instead of setting this profile-wide, so
   * structural relationship types in the same profile don't unintentionally
   * accept arbitrary label overrides. Unset means no relationship type in
   * this profile gets a custom label unless it declares its own.
   */
  displayLabelProperty?: string;
  package: ProfilePackage;
  fallback?: boolean;
}

export interface PropertyDefinition {
  key: string;
  kind: "string" | "number" | "boolean" | "date";
  values?: readonly JsonPrimitive[];
  minimum?: number;
  maximum?: number;
  nodeTypes?: readonly string[];
  relationshipTypes?: readonly string[];
  required?: boolean;
}

export interface ProfileCustomPropertyScopes {
  nodeTypes?: readonly string[];
  relationshipTypes?: readonly string[];
}

export type ProfileNodeVisualIcon =
  | "claim"
  | "fallback"
  | "node"
  | "question"
  | "source"
  | "topic";

export type ProfileRelationshipVisualIcon =
  | "association"
  | "blocks"
  | "contradiction"
  | "dependency"
  | "flow"
  | "hierarchy"
  | "ownership"
  | "reference"
  | "support";

export interface ProfileNodeVisualEncoding {
  icon: ProfileNodeVisualIcon;
  accent: NodeAppearanceAccent;
  shape: NodeAppearanceShape;
}

export interface ProfileRelationshipVisualEncoding {
  icon?: ProfileRelationshipVisualIcon;
  line: RelationshipLinePattern;
  marker: RelationshipEndpointMarker;
  sourceMarker?: RelationshipEndpointMarker;
  targetMarker?: RelationshipEndpointMarker;
  /**
   * Default connector routing for this relationship type when no per-view
   * route override or manual waypoints are set. Defaults to "curved" for
   * the profile's hierarchy relationship and "straight" otherwise.
   */
  defaultRoute?: RelationshipRouteKind;
  /**
   * Whether this relationship type's label is shown by default. Lets a
   * profile with a single relationship type (or a purely structural type
   * like "contains") hide a redundant label, while other types on the
   * same profile still show theirs. A view-level `showRelationshipLabel`
   * override still wins when explicitly set. Defaults to true.
   */
  labelVisible?: boolean;
  /**
   * Whether this relationship type's icon is shown by default. A
   * view-level `showRelationshipIcon` override still wins when
   * explicitly set. Defaults to false.
   */
  iconVisible?: boolean;
}

export interface ProfileNodeTypeDefinition {
  id: string;
  label: string;
  description: string;
  visual: ProfileNodeVisualEncoding;
}

export interface ProfileRelationshipTypeDefinition {
  id: string;
  label: string;
  description: string;
  directed: boolean;
  sourceNodeTypes?: readonly string[];
  targetNodeTypes?: readonly string[];
  allowSelf?: boolean;
  visual: ProfileRelationshipVisualEncoding;
  /**
   * Name of the relationship property that holds a custom display label for
   * *this* relationship type only, e.g. "branch-label". Opting a relationship
   * type in this way lets instances of it override the type's default label
   * with free text, while other relationship types in the same profile keep
   * their fixed, semantic label. Only declare this for relationship types
   * whose meaning is inherently open-ended (e.g. a branch condition); leave
   * it unset for structural types (e.g. hierarchy or blocking relationships)
   * so their label always reflects the declared relationship type.
   * Falls back to the profile-wide `GraphProfile.displayLabelProperty`
   * when unset, for backward compatibility with single-relationship-type
   * profiles that declared it at the profile level.
   */
  displayLabelProperty?: string;
}

export interface ProfileHierarchyConstraints {
  relationshipType: string;
  parentEndpoint: "source" | "target";
  maximumParents: 1;
  acyclic: true;
  /**
   * Which layout orientations this profile's hierarchy supports, in
   * display order. Not every hierarchy profile makes sense as a
   * two-sided "balanced" mind map (e.g. a strict org-chart profile),
   * so this lets the profile declare its own supported subset instead
   * of always offering all five orientations.
   */
  orientations: readonly GraphLayoutOrientation[];
}

export interface ProfilePackage {
  format: "generic-graph-profile";
  formatVersion: 1;
  id: ProfileId;
  version: number;
  name: string;
  description: string;
  compatibility: {
    documentVersions: readonly [1];
    minimumReaderVersion: 1;
  };
  provenance: {
    kind: "built-in" | "imported" | "team" | "user-authored";
    source: string;
    license: {
      name: string;
      spdx?: string;
    };
  };
  trust: {
    level: "blocked" | "trusted" | "unverified";
    rationale: string;
  };
  nodeTypes: readonly ProfileNodeTypeDefinition[];
  relationshipTypes: readonly ProfileRelationshipTypeDefinition[];
  properties: readonly PropertyDefinition[];
  customProperties?: ProfileCustomPropertyScopes;
  hierarchy?: ProfileHierarchyConstraints;
  defaults: {
    nodeType: string;
    relationshipType?: string;
    relationshipTypeByTargetSide?: Partial<Record<ConnectionSide, string>>;
    visibleProperties: readonly string[];
    /**
     * Profile-wide fallback display-label property. Prefer declaring
     * `displayLabelProperty` on individual relationship types in
     * `relationshipTypes` instead, so only the types that need a custom
     * label opt in. See `GraphProfile.displayLabelProperty`.
     */
    displayLabelProperty?: string;
  };
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
  entityId?: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}
