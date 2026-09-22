import type {
  ConnectionSide,
  GraphDocument,
  GraphLayoutOrientation,
  GraphProfile,
  GraphRelationship,
  JsonValue,
  ProfileId,
  ProfileNodeTypeDefinition,
  ProfilePackage,
  ProfileRelationshipTypeDefinition,
  PropertyDefinition
} from "./types.js";

/** Default orientation support for hierarchy profiles that don't declare their own. */
const DEFAULT_HIERARCHY_ORIENTATIONS: readonly GraphLayoutOrientation[] = [
  "top-down"
];

export const BUILT_IN_PROFILE_IDS = [
  "blank",
  "mind-map",
  "knowledge-map",
  "concept-map",
  "decision-tree",
  "dependency-map",
  "architecture-map",
  "network-map",
  "data-model",
  "uml-map",
  "planning-map",
  "roadmap-map",
  "risk-map",
  "journey-map",
  "organization-map",
  "process-map"
] as const;
export type BuiltInProfileId = (typeof BUILT_IN_PROFILE_IDS)[number];

export const STARTER_PROFILE_IDS = [
  "blank",
  "mind-map",
  "knowledge-map"
] as const;
export type StarterProfileId = (typeof STARTER_PROFILE_IDS)[number];

export type ProfileResolutionCode =
  | "profile-duplicate"
  | "profile-incompatible"
  | "profile-malformed"
  | "profile-missing"
  | "profile-unavailable"
  | "profile-untrusted";

export interface ProfileDependency {
  id: ProfileId;
  minimumVersion: number;
}

export interface ExactProfileDependency {
  id: ProfileId;
  version: number;
}

export interface ProfileResolutionFailure {
  ok: false;
  code: ProfileResolutionCode;
  id: ProfileId;
  requestedVersion: number;
  message: string;
  diagnostics: readonly ProfilePackageDiagnostic[];
}

export interface ProfileResolutionSuccess {
  ok: true;
  package: ProfilePackage;
  profile: GraphProfile;
}

export type ProfileResolution =
  | ProfileResolutionFailure
  | ProfileResolutionSuccess;

export interface ProfilePackageDiagnostic {
  code: "duplicate-package" | "invalid-package";
  path: string;
  message: string;
  profileId?: string;
  version?: number;
}

export type ProfilePackageValidation =
  | { valid: true; value: ProfilePackage }
  | { valid: false; diagnostics: readonly ProfilePackageDiagnostic[] };

export interface ProfileRegistryOptions {
  trustDecisions?: ReadonlyMap<
    string,
    { level: "blocked" | "trusted" | "unverified"; rationale: string }
  >;
  unavailablePackages?: ReadonlyMap<string, string>;
}

export interface ProfileRegistry {
  readonly packages: readonly ProfilePackage[];
  readonly diagnostics: readonly ProfilePackageDiagnostic[];
  resolve(dependency: ProfileDependency): ProfileResolution;
  resolveExact(dependency: ExactProfileDependency): ProfileResolution;
  getAll(id: ProfileId): readonly ProfilePackage[];
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MAX_DECLARATIVE_CHARACTERS = 5_000_000;
const MAX_DECLARATIVE_DEPTH = 40;
const MAX_DECLARATIVE_VALUES = 25_000;
const PACKAGE_KEYS = [
  "format",
  "formatVersion",
  "id",
  "version",
  "name",
  "description",
  "compatibility",
  "provenance",
  "trust",
  "nodeTypes",
  "relationshipTypes",
  "properties",
  "customProperties",
  "hierarchy",
  "defaults"
] as const;
const NODE_TYPE_KEYS = ["id", "label", "description", "visual"] as const;
const RELATIONSHIP_TYPE_KEYS = [
  "id",
  "label",
  "description",
  "directed",
  "sourceNodeTypes",
  "targetNodeTypes",
  "allowSelf",
  "visual",
  "displayLabelProperty"
] as const;
const PROPERTY_KEYS = [
  "key",
  "kind",
  "values",
  "minimum",
  "maximum",
  "nodeTypes",
  "relationshipTypes",
  "required"
] as const;
const CUSTOM_PROPERTY_KEYS = ["nodeTypes", "relationshipTypes"] as const;
const NODE_VISUAL_KEYS = ["icon", "accent", "shape"] as const;
const RELATIONSHIP_VISUAL_KEYS = [
  "icon",
  "line",
  "marker",
  "sourceMarker",
  "targetMarker",
  "defaultRoute",
  "labelVisible",
  "iconVisible"
] as const;
const COMPATIBILITY_KEYS = ["documentVersions", "minimumReaderVersion"] as const;
const PROVENANCE_KEYS = ["kind", "source", "license"] as const;
const LICENSE_KEYS = ["name", "spdx"] as const;
const TRUST_KEYS = ["level", "rationale"] as const;
const HIERARCHY_KEYS = [
  "relationshipType",
  "parentEndpoint",
  "maximumParents",
  "acyclic",
  "orientations"
] as const;
const GRAPH_LAYOUT_ORIENTATION_VALUES = [
  "balanced",
  "top-down",
  "bottom-up",
  "left-to-right",
  "right-to-left"
] as const;
const DEFAULT_KEYS = [
  "nodeType",
  "relationshipType",
  "relationshipTypeByTargetSide",
  "visibleProperties",
  "displayLabelProperty"
] as const;
const SIDE_KEYS = ["top", "right", "bottom", "left"] as const;
export const PROFILE_NODE_VISUAL_ICONS = [
  "claim",
  "fallback",
  "node",
  "question",
  "source",
  "topic"
] as const;
const ACCENTS = [
  "blue",
  "cyan",
  "green",
  "neutral",
  "orange",
  "purple",
  "red",
  "yellow"
] as const;
const SHAPES = [
  "capsule",
  "circle",
  "cut-corner",
  "cylinder",
  "diamond",
  "document",
  "fallback",
  "oval",
  "parallelogram",
  "rectangle",
  "rounded"
] as const;
export const PROFILE_RELATIONSHIP_VISUAL_ICONS = [
  "association",
  "blocks",
  "contradiction",
  "dependency",
  "flow",
  "hierarchy",
  "ownership",
  "reference",
  "support"
] as const;

export function profilePackageIdentity(
  profilePackage: Pick<ProfilePackage, "id" | "version">
): string {
  return `${profilePackage.id}@${profilePackage.version}`;
}

export function isStarterProfileId(value: string): value is StarterProfileId {
  return STARTER_PROFILE_IDS.some((profileId) => profileId === value);
}

export function validateProfilePackage(
  candidate: unknown
): ProfilePackageValidation {
  const diagnostics: ProfilePackageDiagnostic[] = [];
  if (!isPlainObject(candidate)) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "invalid-package",
          path: "$",
          message: "Profile package must be a plain declarative object."
        }
      ]
    };
  }

  const identity = safeCandidateIdentity(candidate);
  const push = (path: string, message: string): void => {
    diagnostics.push({
      code: "invalid-package",
      path,
      message,
      ...(identity.id ? { profileId: identity.id } : {}),
      ...(identity.version ? { version: identity.version } : {})
    });
  };

  inspectDeclarativeValue(
    candidate,
    "$",
    { seen: new Set(), count: 0, characters: 0, aborted: false },
    0,
    push
  );
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  exactKeys(candidate, PACKAGE_KEYS, "$", push);
  literal(candidate, "format", "generic-graph-profile", "$", push);
  literal(candidate, "formatVersion", 1, "$", push);
  identifier(candidate, "id", "$", push);
  positiveInteger(candidate, "version", "$", push);
  boundedString(candidate, "name", "$", push, 100);
  boundedString(candidate, "description", "$", push, 500);

  objectField(candidate, "compatibility", "$", push, (value, path) => {
    exactKeys(value, COMPATIBILITY_KEYS, path, push);
    literalArray(value, "documentVersions", [1], path, push);
    literal(value, "minimumReaderVersion", 1, path, push);
  });
  objectField(candidate, "provenance", "$", push, (value, path) => {
    exactKeys(value, PROVENANCE_KEYS, path, push);
    enumField(
      value,
      "kind",
      ["built-in", "imported", "team", "user-authored"] as const,
      path,
      push
    );
    boundedString(value, "source", path, push, 160);
    objectField(value, "license", path, push, (license, licensePath) => {
      exactKeys(license, LICENSE_KEYS, licensePath, push);
      boundedString(license, "name", licensePath, push, 80);
      optionalString(license, "spdx", licensePath, push, 40);
    });
  });
  objectField(candidate, "trust", "$", push, (value, path) => {
    exactKeys(value, TRUST_KEYS, path, push);
    enumField(
      value,
      "level",
      ["blocked", "trusted", "unverified"] as const,
      path,
      push
    );
    boundedString(value, "rationale", path, push, 240);
  });

  arrayField(candidate, "nodeTypes", "$", push, 64, (value, path) => {
    if (!isPlainObject(value)) {
      push(path, "Node type must be a plain object.");
      return;
    }
    exactKeys(value, NODE_TYPE_KEYS, path, push);
    identifier(value, "id", path, push);
    boundedString(value, "label", path, push, 100);
    boundedString(value, "description", path, push, 240);
    objectField(value, "visual", path, push, (visual, visualPath) => {
      exactKeys(visual, NODE_VISUAL_KEYS, visualPath, push);
      enumField(visual, "icon", PROFILE_NODE_VISUAL_ICONS, visualPath, push);
      enumField(visual, "accent", ACCENTS, visualPath, push);
      enumField(visual, "shape", SHAPES, visualPath, push);
    });
  });
  arrayField(
    candidate,
    "relationshipTypes",
    "$",
    push,
    64,
    (value, path) => {
      if (!isPlainObject(value)) {
        push(path, "Relationship type must be a plain object.");
        return;
      }
      exactKeys(value, RELATIONSHIP_TYPE_KEYS, path, push);
      identifier(value, "id", path, push);
      boundedString(value, "label", path, push, 100);
      boundedString(value, "description", path, push, 240);
      booleanField(value, "directed", path, push);
      optionalIdentifierArray(value, "sourceNodeTypes", path, push);
      optionalIdentifierArray(value, "targetNodeTypes", path, push);
      optionalBoolean(value, "allowSelf", path, push);
      optionalIdentifier(value, "displayLabelProperty", path, push);
      objectField(value, "visual", path, push, (visual, visualPath) => {
        exactKeys(visual, RELATIONSHIP_VISUAL_KEYS, visualPath, push);
        if (Object.hasOwn(visual, "icon")) {
          enumField(
            visual,
            "icon",
            PROFILE_RELATIONSHIP_VISUAL_ICONS,
            visualPath,
            push
          );
        }
        enumField(
          visual,
          "line",
          ["solid", "dashed", "dotted"] as const,
          visualPath,
          push
        );
        enumField(
          visual,
          "marker",
          ["arrow", "bar", "circle", "diamond", "none"] as const,
          visualPath,
          push
        );
        for (const key of ["sourceMarker", "targetMarker"] as const) {
          if (Object.hasOwn(visual, key)) {
            enumField(
              visual,
              key,
              ["arrow", "bar", "circle", "diamond", "none"] as const,
              visualPath,
              push
            );
          }
        }
        if (Object.hasOwn(visual, "defaultRoute")) {
          enumField(
            visual,
            "defaultRoute",
            ["straight", "curved", "elbow"] as const,
            visualPath,
            push
          );
        }
        optionalBoolean(visual, "labelVisible", visualPath, push);
        optionalBoolean(visual, "iconVisible", visualPath, push);
      });
    },
    0
  );
  arrayField(candidate, "properties", "$", push, 128, (value, path) => {
    if (!isPlainObject(value)) {
      push(path, "Property definition must be a plain object.");
      return;
    }
    exactKeys(value, PROPERTY_KEYS, path, push);
    identifier(value, "key", path, push);
    enumField(
      value,
      "kind",
      ["string", "number", "boolean", "date"] as const,
      path,
      push
    );
    optionalPrimitiveArray(value, "values", path, push);
    optionalFiniteNumber(value, "minimum", path, push);
    optionalFiniteNumber(value, "maximum", path, push);
    optionalIdentifierArray(value, "nodeTypes", path, push);
    optionalIdentifierArray(value, "relationshipTypes", path, push);
    optionalBoolean(value, "required", path, push);
  }, 0);
  optionalObjectField(
    candidate,
    "customProperties",
    "$",
    push,
    (value, path) => {
      exactKeys(value, CUSTOM_PROPERTY_KEYS, path, push);
      optionalIdentifierArray(value, "nodeTypes", path, push);
      optionalIdentifierArray(value, "relationshipTypes", path, push);
    }
  );
  optionalObjectField(candidate, "hierarchy", "$", push, (value, path) => {
    exactKeys(value, HIERARCHY_KEYS, path, push);
    identifier(value, "relationshipType", path, push);
    enumField(
      value,
      "parentEndpoint",
      ["source", "target"] as const,
      path,
      push
    );
    literal(value, "maximumParents", 1, path, push);
    literal(value, "acyclic", true, path, push);
    enumArrayField(
      value,
      "orientations",
      GRAPH_LAYOUT_ORIENTATION_VALUES,
      path,
      push,
      GRAPH_LAYOUT_ORIENTATION_VALUES.length
    );
  });
  objectField(candidate, "defaults", "$", push, (value, path) => {
    exactKeys(value, DEFAULT_KEYS, path, push);
    identifier(value, "nodeType", path, push);
    optionalIdentifier(value, "relationshipType", path, push);
    optionalObjectField(
      value,
      "relationshipTypeByTargetSide",
      path,
      push,
      (sides, sidesPath) => {
        exactKeys(sides, SIDE_KEYS, sidesPath, push);
        for (const side of SIDE_KEYS) {
          optionalIdentifier(sides, side, sidesPath, push);
        }
      }
    );
    identifierArray(value, "visibleProperties", path, push, 32);
    optionalIdentifier(value, "displayLabelProperty", path, push);
  });

  if (diagnostics.length > 0) return { valid: false, diagnostics };

  const snapshot = cloneAndFreezeDeclarativeValue(candidate) as ProfilePackage;
  validatePackageSemantics(snapshot, push);
  return diagnostics.length > 0
    ? { valid: false, diagnostics }
    : { valid: true, value: snapshot };
}

export function createProfileRegistry(
  candidates: readonly unknown[],
  options: ProfileRegistryOptions = {}
): ProfileRegistry {
  const validPackages: ProfilePackage[] = [];
  const diagnostics: ProfilePackageDiagnostic[] = [];
  const malformed = new Map<string, ProfilePackageDiagnostic[]>();

  candidates.forEach((candidate, index) => {
    const validation = validateProfilePackage(candidate);
    if (validation.valid) {
      validPackages.push(validation.value);
      return;
    }
    const indexed = validation.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `$[${index}]${diagnostic.path.slice(1)}`
    }));
    diagnostics.push(...indexed);
    const id = indexed.find((diagnostic) => diagnostic.profileId)?.profileId;
    if (id) malformed.set(id, [...(malformed.get(id) ?? []), ...indexed]);
  });

  const byIdentity = new Map<string, ProfilePackage[]>();
  for (const profilePackage of validPackages) {
    const identity = profilePackageIdentity(profilePackage);
    byIdentity.set(identity, [
      ...(byIdentity.get(identity) ?? []),
      profilePackage
    ]);
  }
  const duplicateIdentities = new Set<string>();
  for (const [identity, packages] of byIdentity) {
    if (packages.length < 2) continue;
    duplicateIdentities.add(identity);
    const duplicate = packages[0]!;
    diagnostics.push({
      code: "duplicate-package",
      path: "$",
      message: `Duplicate profile package identity "${identity}".`,
      profileId: duplicate.id,
      version: duplicate.version
    });
  }

  const packages = validPackages
    .filter(
      (profilePackage) =>
        !duplicateIdentities.has(profilePackageIdentity(profilePackage))
    )
    .sort(comparePackages);
  Object.freeze(packages);
  const diagnosticSnapshot = diagnostics.map((diagnostic) =>
    Object.freeze(diagnostic)
  );
  Object.freeze(diagnosticSnapshot);
  const registryOptions: ProfileRegistryOptions = {
    ...(options.trustDecisions
      ? {
          trustDecisions: new Map(
            [...options.trustDecisions].map(([identity, decision]) => [
              identity,
              Object.freeze({ ...decision })
            ])
          )
        }
      : {}),
    ...(options.unavailablePackages
      ? { unavailablePackages: new Map(options.unavailablePackages) }
      : {})
  };
  const resolve = (
    id: string,
    requestedVersion: number,
    exact: boolean
  ): ProfileResolution =>
    resolveFromRegistry(
      id,
      requestedVersion,
      exact,
      packages,
      malformed.get(id) ?? [],
      duplicateIdentities,
      validPackages,
      registryOptions
    );

  const registry: ProfileRegistry = {
    packages,
    diagnostics: diagnosticSnapshot,
    resolve: ({ id, minimumVersion }) =>
      resolve(id, minimumVersion, false),
    resolveExact: ({ id, version }) => resolve(id, version, true),
    getAll(id) {
      return Object.freeze(
        packages.filter((profilePackage) => profilePackage.id === id)
      );
    }
  };
  return Object.freeze(registry);
}

export function materializeProfile(profilePackage: ProfilePackage): GraphProfile {
  return {
    id: profilePackage.id,
    version: profilePackage.version,
    name: profilePackage.name,
    description: profilePackage.description,
    nodeTypes: profilePackage.nodeTypes.map(({ id }) => id),
    relationshipTypes: profilePackage.relationshipTypes.map(({ id }) => id),
    ...(profilePackage.hierarchy
      ? {
          hierarchyRelationship: profilePackage.hierarchy.relationshipType,
          hierarchyConstraints: profilePackage.hierarchy
        }
      : {}),
    ...(profilePackage.defaults.relationshipType
      ? { defaultRelationshipType: profilePackage.defaults.relationshipType }
      : {}),
    ...(profilePackage.defaults.relationshipTypeByTargetSide
      ? {
          relationshipTypeByTargetSide:
            profilePackage.defaults.relationshipTypeByTargetSide
        }
      : {}),
    defaultVisibleProperties: profilePackage.defaults.visibleProperties,
    propertyDefinitions: profilePackage.properties,
    nodeTypeDefinitions: profilePackage.nodeTypes,
    relationshipTypeDefinitions: profilePackage.relationshipTypes,
    ...(profilePackage.customProperties
      ? { customProperties: profilePackage.customProperties }
      : {}),
    ...(profilePackage.defaults.displayLabelProperty
      ? { displayLabelProperty: profilePackage.defaults.displayLabelProperty }
      : {}),
    package: profilePackage
  };
}

/**
 * Resolves the display-label property that applies to a specific
 * relationship type: the type's own declaration takes precedence over the
 * profile-wide fallback. Returns `undefined` when neither declares one,
 * meaning that relationship type never accepts a custom label override.
 */
export function resolveDisplayLabelProperty(
  profile: Pick<GraphProfile, "displayLabelProperty">,
  definition: Pick<ProfileRelationshipTypeDefinition, "displayLabelProperty"> | undefined
): string | undefined {
  return definition?.displayLabelProperty ?? profile.displayLabelProperty;
}

export function hierarchyNodeIds(
  profile: Pick<GraphProfile, "hierarchyConstraints">,
  relationship: Pick<GraphRelationship, "source" | "target">
): { parentId: string; childId: string } {
  return profile.hierarchyConstraints?.parentEndpoint === "target"
    ? { parentId: relationship.target, childId: relationship.source }
    : { parentId: relationship.source, childId: relationship.target };
}

export function hierarchyRelationshipEndpoints(
  profile: Pick<GraphProfile, "hierarchyConstraints">,
  parentId: string,
  childId: string
): Pick<GraphRelationship, "source" | "target"> {
  return profile.hierarchyConstraints?.parentEndpoint === "target"
    ? { source: childId, target: parentId }
    : { source: parentId, target: childId };
}

export function getProfile(
  source: ProfileId | Pick<GraphDocument, "document" | "extensions">,
  registry: ProfileRegistry = activeProfileRegistry
): GraphProfile {
  const profileId =
    typeof source === "string" ? source : source.document.profile;
  const resolution =
    typeof source === "string"
      ? registry.resolve({ id: profileId, minimumVersion: 1 })
      : resolveDocumentProfile(source, registry);
  return resolution.ok ? resolution.profile : fallbackProfile(profileId);
}

export function resolveDocumentProfile(
  document: Pick<GraphDocument, "document" | "extensions">,
  registry: ProfileRegistry = activeProfileRegistry
): ProfileResolution {
  const reference = readProfilePackageReference(document.extensions);
  if (reference && reference.id === document.document.profile) {
    return registry.resolveExact(reference);
  }
  return registry.resolve({
    id: document.document.profile,
    minimumVersion: 1
  });
}

export function pinDocumentProfilePackage(
  document: GraphDocument,
  profilePackage: Pick<ProfilePackage, "id" | "version">
): void {
  document.extensions = {
    ...(document.extensions ?? {}),
    profilePackage: {
      id: profilePackage.id,
      version: profilePackage.version
    }
  };
}

export function readProfilePackageReference(
  extensions: Readonly<Record<string, JsonValue>> | undefined
): ExactProfileDependency | undefined {
  const value = extensions?.profilePackage;
  if (!isPlainObject(value)) return undefined;
  return typeof value.id === "string" &&
    ID_PATTERN.test(value.id) &&
    Number.isInteger(value.version) &&
    typeof value.version === "number" &&
    value.version > 0
    ? { id: value.id, version: value.version }
    : undefined;
}

const node = (
  id: string,
  label: string,
  description: string,
  icon: ProfileNodeTypeDefinition["visual"]["icon"],
  accent: ProfileNodeTypeDefinition["visual"]["accent"],
  shape: ProfileNodeTypeDefinition["visual"]["shape"]
): ProfileNodeTypeDefinition => ({
  id,
  label,
  description,
  visual: { icon, accent, shape }
});

const relationship = (
  id: string,
  label: string,
  description: string,
  options: Omit<
    ProfileRelationshipTypeDefinition,
    "id" | "label" | "description" | "visual"
  > & {
    line?: ProfileRelationshipTypeDefinition["visual"]["line"];
    icon?: ProfileRelationshipTypeDefinition["visual"]["icon"];
    marker?: ProfileRelationshipTypeDefinition["visual"]["marker"];
    sourceMarker?: ProfileRelationshipTypeDefinition["visual"]["sourceMarker"];
    targetMarker?: ProfileRelationshipTypeDefinition["visual"]["targetMarker"];
    defaultRoute?: ProfileRelationshipTypeDefinition["visual"]["defaultRoute"];
    labelVisible?: ProfileRelationshipTypeDefinition["visual"]["labelVisible"];
    iconVisible?: ProfileRelationshipTypeDefinition["visual"]["iconVisible"];
  }
): ProfileRelationshipTypeDefinition => {
  const {
    line = "solid",
    icon = defaultRelationshipIcon(id),
    marker = "arrow",
    sourceMarker,
    targetMarker,
    defaultRoute,
    labelVisible,
    iconVisible,
    ...constraints
  } = options;
  return {
    id,
    label,
    description,
    ...constraints,
    visual: {
      icon,
      line,
      marker,
      ...(sourceMarker ? { sourceMarker } : {}),
      ...(targetMarker ? { targetMarker } : {}),
      ...(defaultRoute ? { defaultRoute } : {}),
      ...(labelVisible !== undefined ? { labelVisible } : {}),
      ...(iconVisible !== undefined ? { iconVisible } : {})
    }
  };
};

function defaultRelationshipIcon(
  id: string
): NonNullable<ProfileRelationshipTypeDefinition["visual"]["icon"]> {
  if (["contains", "has-attribute", "member-of", "reports-to"].includes(id)) {
    return "hierarchy";
  }
  if (["depends-on", "implements", "inherits"].includes(id)) {
    return "dependency";
  }
  if (id === "blocks") return "blocks";
  if (
    ["calls", "data-flow", "flows-to", "precedes", "reads", "routes-to", "writes"].includes(id)
  ) {
    return "flow";
  }
  if (["contributes-to", "mitigates", "supported-by", "supports"].includes(id)) {
    return "support";
  }
  if (id === "contradicts") return "contradiction";
  if (["evidenced-by", "references"].includes(id)) return "reference";
  if (id === "owned-by") return "ownership";
  return "association";
}

interface BuiltInPackageInput {
  id: BuiltInProfileId;
  name: string;
  description: string;
  nodeTypes: readonly ProfileNodeTypeDefinition[];
  relationshipTypes: readonly ProfileRelationshipTypeDefinition[];
  properties?: readonly PropertyDefinition[];
  hierarchyRelationship?: string;
  hierarchyParentEndpoint?: "source" | "target";
  hierarchyOrientations?: readonly GraphLayoutOrientation[];
  defaultNodeType: string;
  defaultRelationshipType?: string;
  relationshipTypeByTargetSide?: Partial<Record<ConnectionSide, string>>;
  visibleProperties?: readonly string[];
  displayLabelProperty?: string;
}

const builtInPackage = (input: BuiltInPackageInput): ProfilePackage => ({
  format: "generic-graph-profile",
  formatVersion: 1,
  id: input.id,
  version: 1,
  name: input.name,
  description: input.description,
  compatibility: {
    documentVersions: [1],
    minimumReaderVersion: 1
  },
  provenance: {
    kind: "built-in",
    source: "Generic Graph Canvas",
    license: { name: "MIT", spdx: "MIT" }
  },
  trust: {
    level: "trusted",
    rationale: "Bundled with this pinned application profile registry."
  },
  nodeTypes: input.nodeTypes,
  relationshipTypes: input.relationshipTypes,
  properties: input.properties ?? [],
  customProperties: {
    nodeTypes: input.nodeTypes.map(({ id }) => id),
    relationshipTypes: input.relationshipTypes.map(({ id }) => id)
  },
  ...(input.hierarchyRelationship
    ? {
        hierarchy: {
          relationshipType: input.hierarchyRelationship,
          parentEndpoint: input.hierarchyParentEndpoint ?? "source",
          maximumParents: 1,
          acyclic: true,
          orientations:
            input.hierarchyOrientations ?? DEFAULT_HIERARCHY_ORIENTATIONS
        } as const
      }
    : {}),
  defaults: {
    nodeType: input.defaultNodeType,
    ...(input.defaultRelationshipType
      ? { relationshipType: input.defaultRelationshipType }
      : {}),
    ...(input.relationshipTypeByTargetSide
      ? {
          relationshipTypeByTargetSide:
            input.relationshipTypeByTargetSide
        }
      : {}),
    visibleProperties: input.visibleProperties ?? [],
    ...(input.displayLabelProperty
      ? { displayLabelProperty: input.displayLabelProperty }
      : {})
  }
});

const statusProperty = (
  values: readonly string[],
  nodeTypes?: readonly string[]
): PropertyDefinition => ({
  key: "status",
  kind: "string",
  values,
  ...(nodeTypes ? { nodeTypes } : {})
});

export const BUILT_IN_PROFILE_PACKAGES: readonly ProfilePackage[] = [
  builtInPackage({
    id: "blank",
    name: "Blank graph",
    description: "Flexible nodes and relationships without hierarchy rules.",
    nodeTypes: [node("node", "Node", "General graph node.", "node", "blue", "rectangle")],
    relationshipTypes: [
      relationship("related-to", "Related to", "General undirected association.", {
        directed: false,
        marker: "none",
        defaultRoute: "curved",
        labelVisible: false,
        iconVisible: false
      })
    ],
    properties: [
      {
        key: "priority",
        kind: "string",
        values: ["low", "medium", "high"]
      }
    ],
    defaultNodeType: "node",
    defaultRelationshipType: "related-to"
  }),
  builtInPackage({
    id: "mind-map",
    name: "Mind map",
    description: "One-parent topic hierarchy with optional cross-links.",
    nodeTypes: [node("topic", "Topic", "Mind-map topic.", "topic", "cyan", "rounded")],
    relationshipTypes: [
      relationship("contains", "Contains", "Parent-to-child topic hierarchy.", {
        directed: true,
        defaultRoute: "curved",
        labelVisible: false
      }),
      relationship("related-to", "Related to", "Optional topic cross-link.", {
        directed: false,
        marker: "none"
      })
    ],
    properties: [
      statusProperty(["draft", "active", "blocked", "done"], ["topic"])
    ],
    hierarchyRelationship: "contains",
    hierarchyOrientations: [
      "balanced",
      "top-down",
      "bottom-up",
      "left-to-right",
      "right-to-left"
    ],
    defaultNodeType: "topic",
    defaultRelationshipType: "related-to",
    relationshipTypeByTargetSide: { left: "contains", right: "contains" },
    visibleProperties: ["status"]
  }),
  builtInPackage({
    id: "knowledge-map",
    name: "Knowledge map",
    description: "Topics, claims, sources, and questions with evidence links.",
    nodeTypes: [
      node("topic", "Topic", "Knowledge area or subject.", "topic", "blue", "rounded"),
      node("claim", "Claim", "Assertion supported by evidence.", "claim", "green", "cut-corner"),
      node("source", "Source", "Evidence or reference.", "source", "orange", "document"),
      node("question", "Question", "Open question to investigate.", "question", "purple", "capsule")
    ],
    relationshipTypes: [
      relationship("contains", "Contains", "Topic hierarchy.", {
        directed: true
      }),
      relationship("supports", "Supports", "Evidence supports a claim.", {
        directed: true,
        sourceMarker: "circle",
        displayLabelProperty: "relationship-label"
      }),
      relationship("contradicts", "Contradicts", "A claim challenges another claim.", {
        directed: true,
        line: "dashed",
        targetMarker: "bar"
      }),
      relationship("references", "References", "A node cites a source.", {
        directed: true,
        line: "dotted"
      }),
      relationship("related-to", "Related to", "General knowledge cross-link.", {
        directed: false,
        marker: "none"
      })
    ],
    properties: [
      statusProperty(["open", "active", "resolved"]),
      {
        key: "confidence",
        kind: "number",
        minimum: 0,
        maximum: 1,
        nodeTypes: ["claim"]
      },
      {
        key: "relationship-label",
        kind: "string",
        relationshipTypes: ["supports"]
      }
    ],
    hierarchyRelationship: "contains",
    hierarchyOrientations: [
      "balanced",
      "top-down",
      "bottom-up",
      "left-to-right",
      "right-to-left"
    ],
    defaultNodeType: "topic",
    defaultRelationshipType: "related-to",
    visibleProperties: ["status", "confidence"]
  }),
  builtInPackage({
    id: "concept-map",
    name: "Concept",
    description: "Concepts connected by labeled, directed semantic relationships.",
    nodeTypes: [node("concept", "Concept", "Domain concept or idea.", "topic", "blue", "rounded")],
    relationshipTypes: [
      relationship("relates-to", "Relates to", "Directed concept relationship phrase.", {
        directed: true,
        sourceNodeTypes: ["concept"],
        targetNodeTypes: ["concept"],
        allowSelf: false,
        displayLabelProperty: "relationship-label"
      }),
      relationship("contains", "Contains", "Optional concept hierarchy.", {
        directed: true,
        sourceNodeTypes: ["concept"],
        targetNodeTypes: ["concept"],
        allowSelf: false
      })
    ],
    properties: [
      { key: "definition", kind: "string", nodeTypes: ["concept"] },
      { key: "relationship-label", kind: "string", relationshipTypes: ["relates-to"], required: true }
    ],
    hierarchyRelationship: "contains",
    hierarchyOrientations: [
      "balanced",
      "top-down",
      "bottom-up",
      "left-to-right",
      "right-to-left"
    ],
    defaultNodeType: "concept",
    defaultRelationshipType: "relates-to",
    visibleProperties: ["definition"]
  }),
  builtInPackage({
    id: "decision-tree",
    name: "Decision tree",
    description:
      "A root decision, branching questions, and terminal outcomes connected by custom-labeled branches (e.g. Yes/No/Escalate).",
    nodeTypes: [
      node("decision", "Decision", "The root decision or goal being evaluated.", "topic", "purple", "rounded"),
      node("question", "Question", "A condition or branch point to evaluate.", "question", "orange", "diamond"),
      node("outcome", "Outcome", "A terminal result reached at the end of a path.", "claim", "green", "capsule")
    ],
    relationshipTypes: [
      relationship("leads-to", "Leads to", "Directed path to the next question or outcome, labeled with a custom branch condition.", {
        directed: true,
        sourceNodeTypes: ["decision", "question"],
        targetNodeTypes: ["question", "outcome"],
        allowSelf: false,
        icon: "flow",
        displayLabelProperty: "branch-label"
      })
    ],
    properties: [
      statusProperty(["draft", "active", "blocked", "done"], ["decision", "question", "outcome"]),
      { key: "branch-label", kind: "string", relationshipTypes: ["leads-to"] }
    ],
    hierarchyRelationship: "leads-to",
    hierarchyOrientations: ["top-down", "left-to-right", "right-to-left"],
    defaultNodeType: "question",
    defaultRelationshipType: "leads-to",
    visibleProperties: ["status"]
  }),
  builtInPackage({
    id: "dependency-map",
    name: "Dependency",
    description: "Deliverables and tasks connected by bounded dependency semantics.",
    nodeTypes: [
      node("deliverable", "Deliverable", "Outcome that must be produced.", "topic", "blue", "rounded"),
      node("task", "Task", "Unit of work.", "node", "cyan", "rectangle")
    ],
    relationshipTypes: [
      relationship("depends-on", "Depends on", "Source requires target first.", {
        directed: true,
        allowSelf: false,
        line: "dashed",
        targetMarker: "diamond"
      }),
      relationship("blocks", "Blocks", "Source prevents target progress.", {
        directed: true,
        allowSelf: false,
        targetMarker: "bar"
      })
    ],
    properties: [
      statusProperty(["not-started", "active", "blocked", "done"]),
      { key: "owner", kind: "string" },
      { key: "due-date", kind: "date" }
    ],
    defaultNodeType: "task",
    defaultRelationshipType: "depends-on",
    visibleProperties: ["status", "owner"]
  }),
  builtInPackage({
    id: "architecture-map",
    name: "Architecture",
    description: "Bounded system context and component architecture semantics.",
    nodeTypes: [
      node("system", "System", "System boundary.", "topic", "blue", "rounded"),
      node("actor", "Actor", "Person or role interacting with a system.", "node", "purple", "capsule"),
      node("external-system", "External system", "System outside the focal boundary.", "node", "orange", "rectangle"),
      node("component", "Component", "Deployable or logical component.", "node", "cyan", "rounded"),
      node("service", "Service", "Callable service.", "node", "green", "rounded"),
      node("store", "Store", "Persistent data store.", "source", "orange", "cylinder"),
      node("interface", "Interface", "Exposed contract or boundary.", "node", "purple", "cut-corner")
    ],
    relationshipTypes: [
      relationship("uses", "Uses", "Actor or system uses a target system.", { directed: true, allowSelf: false }),
      relationship("data-flow", "Data flow", "Information moves from source to target.", { directed: true, allowSelf: false, line: "dotted", sourceMarker: "circle" }),
      relationship("depends-on", "Depends on", "Architecture element requires another.", { directed: true, allowSelf: false, line: "dashed", targetMarker: "diamond" }),
      relationship("calls", "Calls", "Runtime invocation.", { directed: true, allowSelf: false, line: "dashed" }),
      relationship("reads", "Reads", "Reads from a store.", { directed: true, targetNodeTypes: ["store"], allowSelf: false, targetMarker: "circle" }),
      relationship("writes", "Writes", "Writes to a store.", { directed: true, targetNodeTypes: ["store"], allowSelf: false, targetMarker: "diamond" })
    ],
    properties: [
      { key: "technology", kind: "string" },
      { key: "owner", kind: "string" },
      { key: "protocol", kind: "string", relationshipTypes: ["calls", "data-flow"] }
    ],
    defaultNodeType: "component",
    defaultRelationshipType: "depends-on",
    visibleProperties: ["technology", "owner"]
  }),
  builtInPackage({
    id: "network-map",
    name: "Network",
    description: "Bounded devices, zones, subnets, and routed network links.",
    nodeTypes: [
      node("device", "Device", "Addressable network device.", "node", "cyan", "rounded"),
      node("zone", "Zone", "Network trust or routing zone.", "topic", "purple", "rounded"),
      node("subnet", "Subnet", "Bounded network address range.", "source", "orange", "rectangle")
    ],
    relationshipTypes: [
      relationship("links-to", "Links to", "Physical or logical network link.", {
        directed: false,
        allowSelf: false,
        line: "solid",
        sourceMarker: "circle",
        targetMarker: "circle"
      }),
      relationship("routes-to", "Routes to", "Directed routing path.", {
        directed: true,
        allowSelf: false,
        line: "dashed"
      })
    ],
    properties: [
      { key: "address", kind: "string", nodeTypes: ["device", "subnet"] },
      { key: "protocol", kind: "string", relationshipTypes: ["links-to", "routes-to"] },
      { key: "zone", kind: "string", nodeTypes: ["device", "subnet"] }
    ],
    defaultNodeType: "device",
    defaultRelationshipType: "links-to",
    visibleProperties: ["address", "zone"]
  }),
  builtInPackage({
    id: "data-model",
    name: "Data model",
    description: "Entities, attributes, keys, and bounded cardinality semantics.",
    nodeTypes: [
      node("entity", "Entity", "Named data entity.", "source", "blue", "rectangle"),
      node("attribute", "Attribute", "Typed entity attribute.", "node", "cyan", "oval")
    ],
    relationshipTypes: [
      relationship("has-attribute", "Has attribute", "Entity owns an attribute.", {
        directed: true,
        sourceNodeTypes: ["entity"],
        targetNodeTypes: ["attribute"],
        allowSelf: false,
        targetMarker: "circle"
      }),
      relationship("relates-to", "Relates to", "Cardinality-bearing entity relationship.", {
        directed: true,
        sourceNodeTypes: ["entity"],
        targetNodeTypes: ["entity"],
        allowSelf: true,
        sourceMarker: "bar",
        targetMarker: "bar"
      })
    ],
    properties: [
      { key: "data-type", kind: "string", nodeTypes: ["attribute"] },
      { key: "key", kind: "string", nodeTypes: ["attribute"] },
      { key: "cardinality", kind: "string", relationshipTypes: ["relates-to"] }
    ],
    defaultNodeType: "entity",
    defaultRelationshipType: "relates-to",
    visibleProperties: ["data-type", "key"]
  }),
  builtInPackage({
    id: "uml-map",
    name: "UML overview",
    description: "Intentionally bounded class and interface overview semantics.",
    nodeTypes: [
      node("class", "Class", "Class overview.", "node", "blue", "rectangle"),
      node("interface", "Interface", "Interface overview.", "node", "purple", "rectangle")
    ],
    relationshipTypes: [
      relationship("inherits", "Inherits", "Class inherits from another class.", {
        directed: true,
        sourceNodeTypes: ["class"],
        targetNodeTypes: ["class"],
        allowSelf: false,
        targetMarker: "diamond"
      }),
      relationship("implements", "Implements", "Class implements an interface.", {
        directed: true,
        sourceNodeTypes: ["class"],
        targetNodeTypes: ["interface"],
        allowSelf: false,
        line: "dashed",
        targetMarker: "diamond"
      }),
      relationship("associates", "Associates", "Bounded association.", {
        directed: false,
        allowSelf: false
      }),
      relationship("depends-on", "Depends on", "Element depends on another.", {
        directed: true,
        allowSelf: false,
        line: "dashed"
      })
    ],
    properties: [
      { key: "namespace", kind: "string" },
      { key: "visibility", kind: "string" }
    ],
    defaultNodeType: "class",
    defaultRelationshipType: "depends-on",
    visibleProperties: ["namespace", "visibility"]
  }),
  builtInPackage({
    id: "planning-map",
    name: "Planning",
    description: "Goals, work, milestones, risks, ownership, and progress.",
    nodeTypes: [
      node("goal", "Goal", "Desired outcome.", "topic", "blue", "rounded"),
      node("objective", "Objective", "Qualitative objective.", "topic", "blue", "rounded"),
      node("key-result", "Key result", "Measurable objective result.", "claim", "green", "cut-corner"),
      node("initiative", "Initiative", "Work contributing to an objective.", "node", "cyan", "rectangle"),
      node("workstream", "Workstream", "Grouped delivery stream.", "topic", "purple", "rounded"),
      node("phase", "Phase", "Ordered planning phase.", "topic", "purple", "rounded"),
      node("milestone", "Milestone", "Dated delivery checkpoint.", "node", "orange", "diamond"),
      node("risk", "Risk", "Potential impediment.", "question", "red", "capsule"),
      node("deliverable", "Deliverable", "Planned output.", "node", "green", "rectangle"),
      node("role", "Role", "Ownership role.", "node", "neutral", "capsule")
    ],
    relationshipTypes: [
      relationship("contains", "Contains", "Planning hierarchy.", { directed: true, allowSelf: false }),
      relationship("contributes-to", "Contributes to", "Work advances an outcome.", { directed: true, allowSelf: false }),
      relationship("owned-by", "Owned by", "Element is owned by a role.", { directed: true, targetNodeTypes: ["role"], allowSelf: false }),
      relationship("depends-on", "Depends on", "Work requires another element.", { directed: true, allowSelf: false }),
      relationship("blocks", "Blocks", "Element prevents another.", { directed: true, allowSelf: false, targetMarker: "bar" }),
      relationship("precedes", "Precedes", "Element occurs before another.", { directed: true, allowSelf: false }),
      ...["responsible", "accountable", "consulted", "informed"].map((id) =>
        relationship(id, id[0]!.toUpperCase() + id.slice(1), `RACI ${id} assignment.`, {
          directed: true,
          targetNodeTypes: ["role"],
          allowSelf: false
        })
      )
    ],
    properties: [
      statusProperty(["not-started", "active", "blocked", "done"]),
      { key: "owner", kind: "string" },
      { key: "confidence", kind: "number", minimum: 0, maximum: 1 },
      { key: "progress", kind: "number", minimum: 0, maximum: 100 },
      { key: "date", kind: "date" }
    ],
    hierarchyRelationship: "contains",
    hierarchyOrientations: ["top-down", "bottom-up", "left-to-right", "right-to-left"],
    defaultNodeType: "initiative",
    defaultRelationshipType: "contains",
    visibleProperties: ["status", "owner", "progress"]
  }),
  builtInPackage({
    id: "roadmap-map",
    name: "Roadmap",
    description:
      "Epic, Project, Phase, Task, and Subtask nodes styled to match Mission Control's project graph, for reference views into externally tracked work and for work breakdown structures. Subtasks reuse the Task node type nested under another Task.",
    nodeTypes: [
      node("epic", "Epic", "Large body of work spanning multiple projects, tracked in Mission Control.", "topic", "purple", "rounded"),
      node("project", "Project", "Grouped body of work tracked in Mission Control.", "topic", "blue", "rounded"),
      node("phase", "Phase", "Ordered stage of a project's work, tracked in Mission Control.", "topic", "orange", "rounded"),
      node("task", "Task", "Unit of work tracked in Mission Control. A subtask is a task nested under another task.", "node", "cyan", "rectangle")
    ],
    relationshipTypes: [
      relationship("contains", "Contains", "Epic contains a project, a project contains a phase, a phase contains a task, and a task can contain a subtask.", {
        directed: true,
        sourceNodeTypes: ["epic", "project", "phase", "task"],
        targetNodeTypes: ["project", "phase", "task"],
        allowSelf: false,
        defaultRoute: "elbow",
        labelVisible: false
      }),
      relationship("depends-on", "Depends on", "Element requires another to complete first.", {
        directed: true,
        allowSelf: false,
        line: "dashed",
        targetMarker: "diamond"
      }),
      relationship("blocks", "Blocks", "Element prevents another from progressing.", {
        directed: true,
        allowSelf: false,
        targetMarker: "bar"
      })
    ],
    properties: [
      {
        key: "status",
        kind: "string",
        values: ["todo", "in_progress", "done", "cancelled"]
      },
      {
        key: "priority",
        kind: "string",
        values: ["critical", "high", "medium", "low", "none"]
      },
      { key: "owner", kind: "string" },
      { key: "due-date", kind: "date" },
      { key: "progress", kind: "number", minimum: 0, maximum: 100 }
    ],
    hierarchyRelationship: "contains",
    hierarchyOrientations: ["top-down", "left-to-right"],
    defaultNodeType: "task",
    defaultRelationshipType: "contains",
    visibleProperties: ["status", "priority", "owner", "due-date"]
  }),
  builtInPackage({
    id: "risk-map",
    name: "Risk",
    description: "Risks assessed with typed likelihood and impact values.",
    nodeTypes: [
      node("risk", "Risk", "Potential event requiring assessment.", "question", "red", "capsule"),
      node("mitigation", "Mitigation", "Action that reduces a risk.", "node", "green", "rounded")
    ],
    relationshipTypes: [
      relationship("affects", "Affects", "Risk affects another risk or mitigation.", {
        directed: true,
        allowSelf: false
      }),
      relationship("mitigates", "Mitigates", "Action mitigates a risk.", {
        directed: true,
        sourceNodeTypes: ["mitigation"],
        targetNodeTypes: ["risk"],
        allowSelf: false
      })
    ],
    properties: [
      {
        key: "likelihood",
        kind: "string",
        values: ["low", "medium", "high"],
        nodeTypes: ["risk"],
        required: true
      },
      {
        key: "impact",
        kind: "string",
        values: ["low", "medium", "high"],
        nodeTypes: ["risk"],
        required: true
      },
      { key: "owner", kind: "string" }
    ],
    defaultNodeType: "risk",
    defaultRelationshipType: "affects",
    visibleProperties: ["likelihood", "impact", "owner"]
  }),
  builtInPackage({
    id: "journey-map",
    name: "Journey",
    description: "Journey stages organized through explicit columns and service lanes.",
    nodeTypes: [
      node("stage", "Stage", "Ordered journey stage.", "topic", "blue", "rounded"),
      node("action", "Action", "Customer action.", "node", "cyan", "rectangle"),
      node("customer-action", "Customer action", "Customer behavior in a service.", "node", "cyan", "rectangle"),
      node("touchpoint", "Touchpoint", "Customer interaction point.", "node", "purple", "rounded"),
      node("pain-point", "Pain point", "Journey friction.", "question", "red", "capsule"),
      node("opportunity", "Opportunity", "Potential journey improvement.", "claim", "green", "cut-corner"),
      node("frontstage", "Frontstage", "Visible service interaction.", "node", "blue", "rounded"),
      node("backstage", "Backstage", "Behind-the-scenes service activity.", "node", "purple", "rounded"),
      node("support", "Support", "Supporting process or system.", "source", "orange", "document")
    ],
    relationshipTypes: [
      relationship("precedes", "Precedes", "Source occurs before target.", {
        directed: true,
        allowSelf: false
      }),
      relationship("supported-by", "Supported by", "Journey element is supported by another.", {
        directed: true,
        allowSelf: false
      }),
      relationship("supports", "Supports", "Service element supports another.", {
        directed: true,
        allowSelf: false
      }),
      relationship("evidenced-by", "Evidenced by", "Element is backed by evidence.", {
        directed: true,
        allowSelf: false
      })
    ],
    properties: [
      { key: "stage", kind: "string" },
      {
        key: "lane",
        kind: "string",
        values: ["customer", "frontstage", "backstage", "support"]
      }
    ],
    defaultNodeType: "action",
    defaultRelationshipType: "precedes",
    visibleProperties: ["stage", "lane"]
  }),
  builtInPackage({
    id: "organization-map",
    name: "Organization",
    description: "People, roles, teams, and bounded reporting relationships.",
    nodeTypes: [
      node("person", "Person", "Individual in the organization.", "node", "blue", "capsule"),
      node("role", "Role", "Organizational role.", "node", "purple", "rounded"),
      node("team", "Team", "Organizational group.", "topic", "cyan", "rounded")
    ],
    relationshipTypes: [
      relationship("reports-to", "Reports to", "Person or role reports to another.", {
        directed: true,
        sourceNodeTypes: ["person", "role"],
        targetNodeTypes: ["person", "role"],
        allowSelf: false
      }),
      relationship("member-of", "Member of", "Person or role belongs to a team.", {
        directed: true,
        sourceNodeTypes: ["person", "role"],
        targetNodeTypes: ["team"],
        allowSelf: false
      }),
      relationship("dotted-line", "Dotted line", "Secondary reporting relationship.", {
        directed: true,
        sourceNodeTypes: ["person", "role"],
        targetNodeTypes: ["person", "role"],
        allowSelf: false,
        line: "dotted"
      })
    ],
    properties: [
      { key: "title", kind: "string", nodeTypes: ["person", "role"] },
      { key: "email", kind: "string", nodeTypes: ["person"] },
      { key: "location", kind: "string" }
    ],
    hierarchyRelationship: "reports-to",
    hierarchyParentEndpoint: "target",
    defaultNodeType: "person",
    defaultRelationshipType: "reports-to",
    visibleProperties: ["title", "location"]
  }),
  builtInPackage({
    id: "process-map",
    name: "Process",
    description: "Bounded directional flow for starts, work, decisions, input, and output.",
    nodeTypes: [
      node("start", "Start", "Process entry point.", "topic", "green", "capsule"),
      node("activity", "Activity", "Process step.", "node", "blue", "rounded"),
      node("decision", "Decision", "Branching decision.", "question", "yellow", "diamond"),
      node("input-output", "Input/output", "Data entering or leaving the process.", "source", "cyan", "parallelogram"),
      node("end", "End", "Process termination.", "topic", "red", "capsule")
    ],
    relationshipTypes: [
      relationship("flows-to", "Flows to", "Directed process transition.", {
        directed: true,
        sourceNodeTypes: ["start", "activity", "decision", "input-output"],
        targetNodeTypes: ["activity", "decision", "input-output", "end"],
        allowSelf: false
      })
    ],
    properties: [
      { key: "owner", kind: "string", nodeTypes: ["activity"] },
      { key: "condition", kind: "string", relationshipTypes: ["flows-to"] },
      { key: "duration", kind: "number", minimum: 0, nodeTypes: ["activity"] }
    ],
    defaultNodeType: "activity",
    defaultRelationshipType: "flows-to",
    visibleProperties: ["owner", "duration"]
  })
];

const BUILT_IN_TRUST = new Map(
  BUILT_IN_PROFILE_PACKAGES.map((profilePackage) => [
    profilePackageIdentity(profilePackage),
    {
      level: "trusted" as const,
      rationale: "Bundled with this pinned application profile registry."
    }
  ])
);

export const PROFILE_REGISTRY = createProfileRegistry(
  BUILT_IN_PROFILE_PACKAGES,
  { trustDecisions: BUILT_IN_TRUST }
);
let activeProfileRegistry = PROFILE_REGISTRY;

export function installUserProfilePackages(
  packages: readonly ProfilePackage[]
): ProfileRegistry {
  const invalid = packages.find(
    (profilePackage) =>
      profilePackage.provenance.kind !== "user-authored" ||
      BUILT_IN_PROFILE_IDS.includes(profilePackage.id as BuiltInProfileId)
  );
  if (invalid) {
    throw new Error(
      `User profile package ${profilePackageIdentity(invalid)} must use user-authored provenance and cannot replace a built-in profile.`
    );
  }
  const trustDecisions = new Map(BUILT_IN_TRUST);
  for (const profilePackage of packages) {
    trustDecisions.set(profilePackageIdentity(profilePackage), {
      level: "trusted",
      rationale:
        "Created locally through the validated custom schema designer."
    });
  }
  const registry = createProfileRegistry(
    [...BUILT_IN_PROFILE_PACKAGES, ...packages],
    { trustDecisions }
  );
  if (registry.diagnostics.length > 0) {
    throw new Error(
      `Unable to install user profile packages: ${registry.diagnostics
        .map(({ message }) => message)
        .join("; ")}`
    );
  }
  activeProfileRegistry = registry;
  return registry;
}

function requiredBuiltInProfile(id: BuiltInProfileId): GraphProfile {
  const resolution = PROFILE_REGISTRY.resolve({ id, minimumVersion: 1 });
  if (!resolution.ok) {
    throw new Error(`Built-in profile ${id} failed to resolve: ${resolution.message}`);
  }
  return resolution.profile;
}

export const PROFILES = {
  blank: requiredBuiltInProfile("blank"),
  "mind-map": requiredBuiltInProfile("mind-map"),
  "knowledge-map": requiredBuiltInProfile("knowledge-map"),
  "concept-map": requiredBuiltInProfile("concept-map"),
  "decision-tree": requiredBuiltInProfile("decision-tree"),
  "dependency-map": requiredBuiltInProfile("dependency-map"),
  "architecture-map": requiredBuiltInProfile("architecture-map"),
  "network-map": requiredBuiltInProfile("network-map"),
  "data-model": requiredBuiltInProfile("data-model"),
  "uml-map": requiredBuiltInProfile("uml-map"),
  "planning-map": requiredBuiltInProfile("planning-map"),
  "roadmap-map": requiredBuiltInProfile("roadmap-map"),
  "risk-map": requiredBuiltInProfile("risk-map"),
  "journey-map": requiredBuiltInProfile("journey-map"),
  "organization-map": requiredBuiltInProfile("organization-map"),
  "process-map": requiredBuiltInProfile("process-map")
} satisfies Record<BuiltInProfileId, GraphProfile>;

function fallbackProfile(profileId: string): GraphProfile {
  const profilePackage: ProfilePackage = {
    format: "generic-graph-profile",
    formatVersion: 1,
    id: profileId,
    version: 1,
    name: profileId,
    description: "Unavailable custom or unknown profile.",
    compatibility: { documentVersions: [1], minimumReaderVersion: 1 },
    provenance: {
      kind: "user-authored",
      source: "Unavailable document profile",
      license: { name: "Unknown" }
    },
    trust: {
      level: "unverified",
      rationale: "The active profile package is unavailable."
    },
    nodeTypes: [
      node("node", "Node", "Safe fallback node.", "fallback", "neutral", "fallback")
    ],
    relationshipTypes: [
      relationship("related-to", "Related to", "Safe fallback relationship.", {
        directed: false,
        allowSelf: false,
        marker: "none"
      })
    ],
    properties: [],
    defaults: {
      nodeType: "node",
      relationshipType: "related-to",
      visibleProperties: []
    }
  };
  return { ...materializeProfile(profilePackage), fallback: true };
}

function resolveFromRegistry(
  id: string,
  requestedVersion: number,
  exact: boolean,
  packages: readonly ProfilePackage[],
  malformedDiagnostics: readonly ProfilePackageDiagnostic[],
  duplicateIdentities: ReadonlySet<string>,
  allValidPackages: readonly ProfilePackage[],
  options: ProfileRegistryOptions
): ProfileResolution {
  const allForId = allValidPackages.filter(
    (profilePackage) => profilePackage.id === id
  );
  const eligible = packages
    .filter(
      (profilePackage) =>
        profilePackage.id === id &&
        (exact
          ? profilePackage.version === requestedVersion
          : profilePackage.version >= requestedVersion)
    )
    .sort((left, right) => right.version - left.version);

  for (const profilePackage of eligible) {
    const identity = profilePackageIdentity(profilePackage);
    const trust = options.trustDecisions?.get(identity) ?? {
      level: "unverified" as const,
      rationale: "The host has not approved this profile package."
    };
    if (trust.level !== "trusted") continue;
    if (options.unavailablePackages?.has(identity)) continue;
    return {
      ok: true,
      package: profilePackage,
      profile: materializeProfile(profilePackage)
    };
  }

  const duplicate = allForId.find(
    (profilePackage) =>
      (exact
        ? profilePackage.version === requestedVersion
        : profilePackage.version >= requestedVersion) &&
      duplicateIdentities.has(profilePackageIdentity(profilePackage))
  );
  if (duplicate) {
    return failure(
      "profile-duplicate",
      id,
      requestedVersion,
      `Profile ${id} version ${duplicate.version} has duplicate package registrations.`,
      [{
        code: "duplicate-package",
        path: "$",
        message: `Duplicate profile package identity "${profilePackageIdentity(duplicate)}".`,
        profileId: id,
        version: duplicate.version
      }]
    );
  }
  if (malformedDiagnostics.length > 0 && eligible.length === 0) {
    return failure(
      "profile-malformed",
      id,
      requestedVersion,
      `Profile ${id} has malformed package registrations.`,
      malformedDiagnostics
    );
  }
  const untrusted = eligible.find((profilePackage) => {
    const trust = options.trustDecisions?.get(
      profilePackageIdentity(profilePackage)
    );
    return trust?.level !== "trusted";
  });
  if (untrusted) {
    const trust = options.trustDecisions?.get(profilePackageIdentity(untrusted));
    return failure(
      "profile-untrusted",
      id,
      requestedVersion,
      trust?.rationale ?? "The host has not approved this profile package.",
      []
    );
  }
  const unavailable = eligible.find((profilePackage) =>
    options.unavailablePackages?.has(profilePackageIdentity(profilePackage))
  );
  if (unavailable) {
    return failure(
      "profile-unavailable",
      id,
      requestedVersion,
      options.unavailablePackages?.get(profilePackageIdentity(unavailable)) ??
        `Profile package ${profilePackageIdentity(unavailable)} is unavailable.`,
      []
    );
  }
  if (allForId.length > 0) {
    return failure(
      "profile-incompatible",
      id,
      requestedVersion,
      exact
        ? `Profile ${id} version ${requestedVersion} is not installed.`
        : `Profile ${id} has no compatible package at version ${requestedVersion} or newer.`,
      []
    );
  }
  return failure(
    "profile-missing",
    id,
    requestedVersion,
    `Profile ${id} is not installed.`,
    malformedDiagnostics
  );
}

function failure(
  code: ProfileResolutionCode,
  id: string,
  requestedVersion: number,
  message: string,
  diagnostics: readonly ProfilePackageDiagnostic[]
): ProfileResolutionFailure {
  return { ok: false, code, id, requestedVersion, message, diagnostics };
}

function comparePackages(left: ProfilePackage, right: ProfilePackage): number {
  const id = left.id.localeCompare(right.id, "en");
  return id !== 0 ? id : left.version - right.version;
}

function validatePackageSemantics(
  profilePackage: ProfilePackage,
  push: (path: string, message: string) => void
): void {
  const nodeTypes = new Set(profilePackage.nodeTypes.map(({ id }) => id));
  const relationshipTypes = new Set(
    profilePackage.relationshipTypes.map(({ id }) => id)
  );
  uniqueIds(profilePackage.nodeTypes, "$.nodeTypes", "node type", push);
  uniqueIds(
    profilePackage.relationshipTypes,
    "$.relationshipTypes",
    "relationship type",
    push
  );
  uniqueIds(profilePackage.properties, "$.properties", "property", push, "key");
  if (!nodeTypes.has(profilePackage.defaults.nodeType)) {
    push("$.defaults.nodeType", "Default node type must be declared.");
  }
  const defaultRelationship = profilePackage.defaults.relationshipType;
  if (defaultRelationship && !relationshipTypes.has(defaultRelationship)) {
    push(
      "$.defaults.relationshipType",
      "Default relationship type must be declared."
    );
  }
  for (const [side, relationshipType] of Object.entries(
    profilePackage.defaults.relationshipTypeByTargetSide ?? {}
  )) {
    if (!relationshipTypes.has(relationshipType)) {
      push(
        `$.defaults.relationshipTypeByTargetSide.${side}`,
        "Suggested relationship type must be declared."
      );
    }
  }
  if (
    profilePackage.hierarchy &&
    !relationshipTypes.has(profilePackage.hierarchy.relationshipType)
  ) {
    push(
      "$.hierarchy.relationshipType",
      "Hierarchy relationship type must be declared."
    );
  }
  const propertyKeysByRelationshipType = new Map<string, PropertyDefinition>(
    profilePackage.properties.map((definition) => [definition.key, definition])
  );
  for (const [index, definition] of profilePackage.relationshipTypes.entries()) {
    validateTypeReferences(
      definition.sourceNodeTypes,
      nodeTypes,
      `$.relationshipTypes[${index}].sourceNodeTypes`,
      push
    );
    validateTypeReferences(
      definition.targetNodeTypes,
      nodeTypes,
      `$.relationshipTypes[${index}].targetNodeTypes`,
      push
    );
    if (definition.displayLabelProperty !== undefined) {
      validateDisplayLabelProperty(
        definition.displayLabelProperty,
        propertyKeysByRelationshipType,
        definition.id,
        `$.relationshipTypes[${index}].displayLabelProperty`,
        push
      );
    }
  }
  if (profilePackage.defaults.displayLabelProperty !== undefined) {
    const property = propertyKeysByRelationshipType.get(
      profilePackage.defaults.displayLabelProperty
    );
    if (!property) {
      push(
        "$.defaults.displayLabelProperty",
        "Display label property must be declared in properties."
      );
    } else if (property.kind !== "string") {
      push(
        "$.defaults.displayLabelProperty",
        "Display label property must be a string property."
      );
    }
  }
  for (const [index, definition] of profilePackage.properties.entries()) {
    validateTypeReferences(
      definition.nodeTypes,
      nodeTypes,
      `$.properties[${index}].nodeTypes`,
      push
    );
    validateTypeReferences(
      definition.relationshipTypes,
      relationshipTypes,
      `$.properties[${index}].relationshipTypes`,
      push
    );
    if (
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    ) {
      push(
        `$.properties[${index}]`,
        "Property minimum must not exceed maximum."
      );
    }
    if (
      (definition.minimum !== undefined || definition.maximum !== undefined) &&
      definition.kind !== "number"
    ) {
      push(
        `$.properties[${index}]`,
        "Only number properties may declare minimum or maximum."
      );
    }
    if (
      definition.values?.some((value) => !primitiveMatchesKind(value, definition.kind))
    ) {
      push(
        `$.properties[${index}].values`,
        "Allowed property values must match the property kind."
      );
    }
  }
  if (profilePackage.customProperties) {
    validateTypeReferences(
      profilePackage.customProperties.nodeTypes,
      nodeTypes,
      "$.customProperties.nodeTypes",
      push
    );
    validateTypeReferences(
      profilePackage.customProperties.relationshipTypes,
      relationshipTypes,
      "$.customProperties.relationshipTypes",
      push
    );
  }
  const propertyKeys = new Set(profilePackage.properties.map(({ key }) => key));
  for (const [index, key] of profilePackage.defaults.visibleProperties.entries()) {
    if (!propertyKeys.has(key)) {
      push(
        `$.defaults.visibleProperties[${index}]`,
        "Visible property must be declared."
      );
    }
  }
}

function validateDisplayLabelProperty(
  key: string,
  propertiesByKey: Map<string, PropertyDefinition>,
  relationshipTypeId: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  const property = propertiesByKey.get(key);
  if (!property) {
    push(path, "Display label property must be declared in properties.");
    return;
  }
  if (property.kind !== "string") {
    push(path, "Display label property must be a string property.");
  }
  if (
    property.relationshipTypes &&
    !property.relationshipTypes.includes(relationshipTypeId)
  ) {
    push(
      path,
      "Display label property must be scoped to this relationship type (or left unscoped)."
    );
  }
}

function primitiveMatchesKind(
  value: null | boolean | number | string,
  kind: PropertyDefinition["kind"]
): boolean {
  return (
    (kind === "string" && typeof value === "string") ||
    (kind === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (kind === "boolean" && typeof value === "boolean") ||
    (kind === "date" && isProfileDateValue(value))
  );
}

export function isProfileDateValue(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}

function validateTypeReferences(
  values: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
  path: string,
  push: (path: string, message: string) => void
): void {
  values?.forEach((value, index) => {
    if (!allowed.has(value)) {
      push(`${path}[${index}]`, `Referenced type "${value}" is not declared.`);
    }
  });
}

function uniqueIds<T extends object>(
  values: readonly T[],
  path: string,
  label: string,
  push: (path: string, message: string) => void,
  key: "id" | "key" = "id"
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const id = Reflect.get(value, key);
    if (typeof id !== "string") return;
    if (seen.has(id)) push(`${path}[${index}].${key}`, `Duplicate ${label} "${id}".`);
    seen.add(id);
  });
}

function safeCandidateIdentity(
  candidate: Record<string, unknown>
): { id?: string; version?: number } {
  const idDescriptor = Object.getOwnPropertyDescriptor(candidate, "id");
  const versionDescriptor = Object.getOwnPropertyDescriptor(candidate, "version");
  const id =
    idDescriptor &&
    "value" in idDescriptor &&
    typeof idDescriptor.value === "string"
      ? idDescriptor.value
      : undefined;
  const version =
    versionDescriptor &&
    "value" in versionDescriptor &&
    Number.isInteger(versionDescriptor.value) &&
    versionDescriptor.value > 0
      ? versionDescriptor.value
      : undefined;
  return {
    ...(id ? { id } : {}),
    ...(version ? { version } : {})
  };
}

function inspectDeclarativeValue(
  value: unknown,
  path: string,
  state: {
    seen: Set<object>;
    count: number;
    characters: number;
    aborted: boolean;
  },
  depth: number,
  push: (path: string, message: string) => void
): void {
  if (state.aborted) return;
  state.count += 1;
  if (state.count > MAX_DECLARATIVE_VALUES) {
    state.aborted = true;
    push(
      path,
      `Profile package exceeds ${MAX_DECLARATIVE_VALUES} declarative values.`
    );
    return;
  }
  if (depth > MAX_DECLARATIVE_DEPTH) {
    push(
      path,
      `Profile package exceeds ${MAX_DECLARATIVE_DEPTH} nested declarative levels.`
    );
    return;
  }
  if (typeof value === "string") {
    addDeclarativeCharacters(value.length, path, state, push);
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    push(path, "Only finite JSON-compatible declarative values are allowed.");
    return;
  }
  if (state.seen.has(value)) {
    push(path, "Cyclic package values are not allowed.");
    return;
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      push(path, "Profile package arrays must use the standard array prototype.");
    }
    if (Object.keys(value).length !== value.length) {
      push(path, "Sparse arrays are not allowed.");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (
        key === "length" ||
        (typeof key === "string" &&
          /^(?:0|[1-9]\d*)$/.test(key) &&
          Number(key) < value.length)
      ) {
        continue;
      }
      push(path, "Array properties and symbol keys are not allowed.");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor && "value" in descriptor) {
        inspectDeclarativeValue(
          descriptor.value,
          `${path}[${index}]`,
          state,
          depth + 1,
          push
        );
      }
    }
    state.seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    push(path, "Profile package objects must use a plain prototype.");
    state.seen.delete(value);
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      push(path, "Symbol keys are not allowed.");
      continue;
    }
    if (!addDeclarativeCharacters(key.length, path, state, push)) {
      state.seen.delete(value);
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("get" in descriptor || "set" in descriptor) {
      push(`${path}.${key}`, "Accessor properties are not allowed.");
      continue;
    }
    if (!descriptor.enumerable) {
      push(`${path}.${key}`, "Non-enumerable properties are not allowed.");
      continue;
    }
    inspectDeclarativeValue(
      descriptor.value,
      `${path}.${key}`,
      state,
      depth + 1,
      push
    );
  }
  state.seen.delete(value);
}

function addDeclarativeCharacters(
  length: number,
  path: string,
  state: { characters: number; aborted: boolean },
  push: (path: string, message: string) => void
): boolean {
  state.characters += length;
  if (state.characters <= MAX_DECLARATIVE_CHARACTERS) return true;
  state.aborted = true;
  push(
    path,
    `Profile package exceeds ${MAX_DECLARATIVE_CHARACTERS} cumulative string and property-key characters.`
  );
  return false;
}

function cloneAndFreezeDeclarativeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
      clone.push(cloneAndFreezeDeclarativeValue(descriptor.value));
    }
    return Object.freeze(clone);
  }

  const clone: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(value)
  ) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    clone[key] = cloneAndFreezeDeclarativeValue(descriptor.value);
  }
  return Object.freeze(clone);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  push: (path: string, message: string) => void
): void {
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if (!allowed.includes(key)) push(`${path}.${key}`, "Unknown fields are not allowed.");
    if ("get" in descriptor || "set" in descriptor) {
      push(`${path}.${key}`, "Accessor properties are not allowed.");
    }
  }
}

function boundedString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  maximum: number
): void {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0 || field.length > maximum) {
    push(`${path}.${key}`, `Must be a non-empty string of at most ${maximum} characters.`);
  }
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  maximum: number
): void {
  if (!Object.hasOwn(value, key)) return;
  boundedString(value, key, path, push, maximum);
}

function identifier(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  boundedString(value, key, path, push, 100);
  if (typeof value[key] === "string" && !ID_PATTERN.test(value[key])) {
    push(`${path}.${key}`, "Must be a lowercase declarative identifier.");
  }
}

function optionalIdentifier(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (Object.hasOwn(value, key)) identifier(value, key, path, push);
}

function positiveInteger(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (
    typeof value[key] !== "number" ||
    !Number.isInteger(value[key]) ||
    value[key] <= 0
  ) {
    push(`${path}.${key}`, "Must be a positive integer.");
  }
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (typeof value[key] !== "boolean") push(`${path}.${key}`, "Must be a boolean.");
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (Object.hasOwn(value, key)) booleanField(value, key, path, push);
}

function literal(
  value: Record<string, unknown>,
  key: string,
  expected: unknown,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (value[key] !== expected) push(`${path}.${key}`, `Must equal ${String(expected)}.`);
}

function enumField<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  push: (path: string, message: string) => void
): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as T)) {
    push(`${path}.${key}`, `Must be one of: ${allowed.join(", ")}.`);
  }
}

function enumArrayField<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  push: (path: string, message: string) => void,
  maximum: number
): void {
  const field = value[key];
  if (!Array.isArray(field) || field.length === 0 || field.length > maximum) {
    push(
      `${path}.${key}`,
      `Must be a non-empty array of at most ${maximum} items.`
    );
    return;
  }
  if (Object.keys(field).length !== field.length) {
    push(`${path}.${key}`, "Sparse arrays are not allowed.");
    return;
  }
  const seen = new Set<string>();
  field.forEach((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      push(`${path}.${key}[${index}]`, `Must be one of: ${allowed.join(", ")}.`);
    } else if (seen.has(item)) {
      push(`${path}.${key}[${index}]`, "Duplicate value.");
    } else {
      seen.add(item);
    }
  });
}

function objectField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  validate: (value: Record<string, unknown>, path: string) => void
): void {
  const field = value[key];
  if (!isPlainObject(field)) {
    push(`${path}.${key}`, "Must be a plain object.");
    return;
  }
  validate(field, `${path}.${key}`);
}

function optionalObjectField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  validate: (value: Record<string, unknown>, path: string) => void
): void {
  if (Object.hasOwn(value, key)) objectField(value, key, path, push, validate);
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  maximum: number,
  validate: (value: unknown, path: string) => void,
  minimum = 1
): void {
  const field = value[key];
  if (
    !Array.isArray(field) ||
    field.length < minimum ||
    field.length > maximum
  ) {
    push(
      `${path}.${key}`,
      minimum === 0
        ? `Must be an array of at most ${maximum} items.`
        : `Must be a non-empty array of at most ${maximum} items.`
    );
    return;
  }
  if (Object.keys(field).length !== field.length) {
    push(`${path}.${key}`, "Sparse arrays are not allowed.");
    return;
  }
  field.forEach((item, index) => validate(item, `${path}.${key}[${index}]`));
}

function identifierArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void,
  maximum = 64
): void {
  const field = value[key];
  if (!Array.isArray(field) || field.length > maximum) {
    push(`${path}.${key}`, `Must be an array of at most ${maximum} identifiers.`);
    return;
  }
  if (Object.keys(field).length !== field.length) {
    push(`${path}.${key}`, "Sparse arrays are not allowed.");
    return;
  }
  field.forEach((item, index) => {
    if (typeof item !== "string" || !ID_PATTERN.test(item)) {
      push(`${path}.${key}[${index}]`, "Must be a lowercase declarative identifier.");
    }
  });
}

function optionalIdentifierArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (Object.hasOwn(value, key)) identifierArray(value, key, path, push);
}

function literalArray(
  value: Record<string, unknown>,
  key: string,
  expected: readonly unknown[],
  path: string,
  push: (path: string, message: string) => void
): void {
  const field = value[key];
  if (
    !Array.isArray(field) ||
    field.length !== expected.length ||
    field.some((item, index) => item !== expected[index])
  ) {
    push(`${path}.${key}`, `Must equal [${expected.join(", ")}].`);
  }
}

function optionalPrimitiveArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (!Object.hasOwn(value, key)) return;
  const field = value[key];
  if (
    !Array.isArray(field) ||
    field.length === 0 ||
    field.length > 64 ||
    Object.keys(field).length !== field.length ||
    field.some(
      (item) =>
        item !== null &&
        typeof item !== "boolean" &&
        typeof item !== "string" &&
        !(typeof item === "number" && Number.isFinite(item))
    )
  ) {
    push(`${path}.${key}`, "Must be a dense array of JSON primitive values.");
  }
}

function optionalFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  push: (path: string, message: string) => void
): void {
  if (!Object.hasOwn(value, key)) return;
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    push(`${path}.${key}`, "Must be a finite number.");
  }
}
