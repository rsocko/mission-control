import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import schema from "./schema/graph-document-v1.schema.json" with { type: "json" };
import {
  hierarchyNodeIds,
  isProfileDateValue,
  materializeProfile,
  readProfilePackageReference,
  resolveDocumentProfile
} from "./profiles.js";
import type {
  Diagnostic,
  GraphDocument,
  GraphProfile,
  GraphResource,
  GraphRelationship,
  IconPickerResource,
  JsonValue,
  MediaResource,
  ProfilePackage,
  PropertyDefinition,
  VisualEncodingRule,
  ValidationResult
} from "./types.js";
import { ICON_PICKER_SOURCES } from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true
});
const validateSchema = ajv.compile<GraphDocument>(schema);

export const GRAPH_DOCUMENT_V1_SCHEMA = schema;

function schemaDiagnostic(error: ErrorObject): Diagnostic {
  if (error.instancePath === "/views" && error.keyword === "minItems") {
    return {
      severity: "error",
      code: "empty-views",
      message:
        "A graph document must contain at least one view; workspaces and adapters always project a primary view.",
      path: "/views"
    };
  }
  const pathParts = error.instancePath.split("/");
  const routeIndex = pathParts.indexOf("routes");
  const routeId =
    routeIndex >= 0 && pathParts[routeIndex + 1]
      ? pathParts[routeIndex + 1]!.replaceAll("~1", "/").replaceAll("~0", "~")
      : undefined;
  return {
    severity: "error",
    code: `schema.${error.keyword}`,
    message: error.message ?? "Schema validation failed",
    path: error.instancePath || "/",
    ...(routeId ? { entityId: routeId } : {})
  };
}

function duplicateDiagnostics(
  values: readonly string[],
  kind: "node" | "relationship" | "view"
): Diagnostic[] {
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      diagnostics.push({
        severity: "error",
        code: `duplicate-${kind}-id`,
        message: `Duplicate ${kind} ID: ${value}`,
        entityId: value
      });
    }
    seen.add(value);
  }
  return diagnostics;
}

function primitiveKey(value: import("./types.js").JsonPrimitive): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMOJI_VALUE_PATTERN =
  /^(?:[#*0-9]\ufe0f?\u20e3|(?=[\s\S]*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f)+)$/u;
const UNSAFE_ICON_VALUE_PATTERN = /(?:https?:|data:|<|>|&lt;|&gt;|svg|javascript:)/i;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const UNSAFE_MEDIA_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml"
]);
// Bounds the "embedded" escape hatch so a single resource cannot silently
// reintroduce MindSpark-style inline base64 bloat into the canonical document.
const EMBEDDED_MEDIA_MAX_LENGTH = 200_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const RELATIVE_MEDIA_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function iconResourceDiagnostics(
  resource: IconPickerResource,
  path = "/resources"
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (resource.contractVersion !== 1) {
    diagnostics.push({
      severity: "error",
      code: "unsupported-icon-contract-version",
      message: `Icon resource ${resource.id} uses unsupported contract version ${resource.contractVersion}; this reader supports version 1.`,
      path: `${path}/contractVersion`,
      entityId: resource.id
    });
  }
  const separator = resource.value.indexOf(":");
  const source = separator > 0 ? resource.value.slice(0, separator) : "";
  const name = separator > 0 ? resource.value.slice(separator + 1) : "";
  if (!ICON_PICKER_SOURCES.includes(source as (typeof ICON_PICKER_SOURCES)[number])) {
    diagnostics.push({
      severity: "error",
      code: "unsupported-icon-source",
      message: `Icon resource ${resource.id} must use one of: ${ICON_PICKER_SOURCES.join(", ")}. Legacy unprefixed values are not accepted.`,
      path: `${path}/value`,
      entityId: resource.id
    });
  } else if (
    !name ||
    UNSAFE_ICON_VALUE_PATTERN.test(resource.value) ||
    (source === "emoji"
      ? !EMOJI_VALUE_PATTERN.test(name)
      : !ICON_NAME_PATTERN.test(name))
  ) {
    diagnostics.push({
      severity: "error",
      code: "unsafe-icon-value",
      message: `Icon resource ${resource.id} contains an unsafe or non-canonical icon value.`,
      path: `${path}/value`,
      entityId: resource.id
    });
  }
  return diagnostics;
}

export function mediaResourceDiagnostics(
  resource: MediaResource,
  path = "/resources"
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (resource.contractVersion !== 1) {
    diagnostics.push({
      severity: "error",
      code: "unsupported-media-contract-version",
      message: `Media resource ${resource.id} uses unsupported contract version ${resource.contractVersion}; this reader supports version 1.`,
      path: `${path}/contractVersion`,
      entityId: resource.id
    });
  }
  if (!resource.altText.trim()) {
    diagnostics.push({
      severity: "error",
      code: "missing-media-alt-text",
      message: `Media resource ${resource.id} must declare non-empty altText for accessible fallback rendering.`,
      path: `${path}/altText`,
      entityId: resource.id
    });
  }
  if (
    !MEDIA_TYPE_PATTERN.test(resource.mediaType) ||
    UNSAFE_MEDIA_TYPES.has(resource.mediaType.toLowerCase())
  ) {
    diagnostics.push({
      severity: "error",
      code: "unsupported-media-type",
      message: `Media resource ${resource.id} declares an unsupported or unsafe media type: ${resource.mediaType}.`,
      path: `${path}/mediaType`,
      entityId: resource.id
    });
  }
  if (
    (resource.width !== undefined && !(resource.width > 0)) ||
    (resource.height !== undefined && !(resource.height > 0))
  ) {
    diagnostics.push({
      severity: "error",
      code: "invalid-media-dimensions",
      message: `Media resource ${resource.id} declares non-positive width/height.`,
      path: `${path}/width`,
      entityId: resource.id
    });
  }
  switch (resource.source.kind) {
    case "relative-file": {
      const relativePath = resource.source.path;
      if (
        !relativePath ||
        relativePath.includes("..") ||
        relativePath.includes("\\") ||
        relativePath.startsWith("/") ||
        /^[a-zA-Z]:/.test(relativePath) ||
        !RELATIVE_MEDIA_PATH_PATTERN.test(relativePath)
      ) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-media-path",
          message: `Media resource ${resource.id} declares an unsafe relative-file path; paths must stay within the document's sidecar assets folder.`,
          path: `${path}/source/path`,
          entityId: resource.id
        });
      }
      break;
    }
    case "host": {
      if (!resource.source.reference.trim()) {
        diagnostics.push({
          severity: "error",
          code: "missing-media-host-reference",
          message: `Media resource ${resource.id} must declare a non-empty host reference.`,
          path: `${path}/source/reference`,
          entityId: resource.id
        });
      }
      break;
    }
    case "embedded": {
      const data = resource.source.data;
      if (!data || !BASE64_PATTERN.test(data)) {
        diagnostics.push({
          severity: "error",
          code: "invalid-embedded-media-data",
          message: `Media resource ${resource.id} embedded data must be non-empty base64.`,
          path: `${path}/source/data`,
          entityId: resource.id
        });
      } else if (data.length > EMBEDDED_MEDIA_MAX_LENGTH) {
        diagnostics.push({
          severity: "error",
          code: "embedded-media-too-large",
          message: `Media resource ${resource.id} embedded data exceeds the ${EMBEDDED_MEDIA_MAX_LENGTH}-character bound for the embedded escape hatch; use a relative-file or host reference instead.`,
          path: `${path}/source/data`,
          entityId: resource.id
        });
      }
      break;
    }
  }
  return diagnostics;
}

function richResourceDiagnostics(document: GraphDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const resources = new Map<string, GraphResource>();
  for (const [index, resource] of (document.resources ?? []).entries()) {
    if (resources.has(resource.id)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate-resource-id",
        message: `Duplicate resource ID: ${resource.id}`,
        path: `/resources/${index}/id`,
        entityId: resource.id
      });
    } else {
      resources.set(resource.id, resource);
    }
    diagnostics.push(
      ...(resource.kind === "media"
        ? mediaResourceDiagnostics(resource, `/resources/${index}`)
        : iconResourceDiagnostics(resource, `/resources/${index}`))
    );
  }
  for (const [nodeIndex, node] of document.nodes.entries()) {
    if (node.card?.iconResourceId) {
      const resource = resources.get(node.card.iconResourceId);
      if (!resource) {
        diagnostics.push({
          severity: "error",
          code: "missing-icon-resource",
          message: `Rich card on ${node.id} references missing resource ${node.card.iconResourceId}.`,
          path: `/nodes/${nodeIndex}/card/iconResourceId`,
          entityId: node.id
        });
      } else if (resource.kind !== "icon-picker") {
        diagnostics.push({
          severity: "error",
          code: "wrong-resource-kind",
          message: `Rich card on ${node.id} references resource ${node.card.iconResourceId} via iconResourceId, but it is a "${resource.kind}" resource.`,
          path: `/nodes/${nodeIndex}/card/iconResourceId`,
          entityId: node.id
        });
      }
    }
    if (node.card?.mediaResourceId) {
      const resource = resources.get(node.card.mediaResourceId);
      if (!resource) {
        diagnostics.push({
          severity: "error",
          code: "missing-media-resource",
          message: `Rich card on ${node.id} references missing resource ${node.card.mediaResourceId}.`,
          path: `/nodes/${nodeIndex}/card/mediaResourceId`,
          entityId: node.id
        });
      } else if (resource.kind !== "media") {
        diagnostics.push({
          severity: "error",
          code: "wrong-resource-kind",
          message: `Rich card on ${node.id} references resource ${node.card.mediaResourceId} via mediaResourceId, but it is a "${resource.kind}" resource.`,
          path: `/nodes/${nodeIndex}/card/mediaResourceId`,
          entityId: node.id
        });
      }
    }
    const sectionKinds = node.card?.sections.map(({ kind }) => kind) ?? [];
    if (new Set(sectionKinds).size !== sectionKinds.length) {
      diagnostics.push({
        severity: "error",
        code: "duplicate-rich-card-section",
        message: `Rich card on ${node.id} repeats a section kind.`,
        path: `/nodes/${nodeIndex}/card/sections`,
        entityId: node.id
      });
    }
  }
  return diagnostics;
}

function viewStructureDiagnostics(document: GraphDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = new Set(document.nodes.map(({ id }) => id));
  for (const view of document.views) {
    if (!view.structure) continue;
    const axisIds = new Set<string>();
    const regionIds = new Set<string>();
    for (const axis of view.structure.axes) {
          if (axisIds.has(axis.id)) {
            diagnostics.push({
              severity: "error",
              code: "duplicate-axis-id",
              message: `Duplicate axis ID in ${view.id}: ${axis.id}`,
              entityId: axis.id
            });
          }
          axisIds.add(axis.id);
          const values = new Set<string>();
          for (const entry of axis.values) {
            const key = primitiveKey(entry.value);
            if (values.has(key)) {
              diagnostics.push({
                severity: "error",
                code: "duplicate-axis-value",
                message: `Axis ${axis.id} contains duplicate value ${String(entry.value)}`,
                entityId: axis.id
              });
            }
            values.add(key);
          }
          const temporalValues = axis.values.map(({ value }) => value);
          if (
            axis.scale === "temporal" &&
            (temporalValues.some((value) => !isProfileDateValue(value)) ||
              temporalValues.some(
                (value, index) =>
                  index > 0 &&
                  typeof value === "string" &&
                  typeof temporalValues[index - 1] === "string" &&
                  value <= temporalValues[index - 1]!
              ))
          ) {
            diagnostics.push({
              severity: "error",
              code: "invalid-temporal-axis-value",
              message: `Temporal axis ${axis.id} requires ordered ISO date values`,
              entityId: axis.id
            });
          }
        }
        for (const region of view.structure.regions) {
          if (regionIds.has(region.id)) {
            diagnostics.push({
              severity: "error",
              code: "duplicate-region-id",
              message: `Duplicate region ID in ${view.id}: ${region.id}`,
              entityId: region.id
            });
          }
          regionIds.add(region.id);
          for (const [axisId, value] of Object.entries(region.axisValues ?? {})) {
            const axis = view.structure.axes.find(({ id }) => id === axisId);
            if (!axis) {
              diagnostics.push({
                severity: "error",
                code: "missing-region-axis",
                message: `Region ${region.id} references missing axis ${axisId}`,
                entityId: region.id
              });
            } else if (
              !axis.values.some(
                (entry) => primitiveKey(entry.value) === primitiveKey(value)
              )
            ) {
              diagnostics.push({
                severity: "error",
                code: "invalid-region-axis-value",
                message: `Region ${region.id} uses a value outside axis ${axisId}`,
                entityId: region.id
              });
            }
          }
          if (region.layout) {
            for (const axisId of region.layout.axisIds ?? []) {
              if (!axisIds.has(axisId)) {
                diagnostics.push({
                  severity: "error",
                  code: "missing-region-layout-axis",
                  message: `Region ${region.id} layout references missing axis ${axisId}`,
                  entityId: region.id
                });
              }
            }
            if (region.layout.rootId && !nodeIds.has(region.layout.rootId)) {
              diagnostics.push({
                severity: "error",
                code: "missing-region-layout-root",
                message: `Region ${region.id} layout references missing root node ${region.layout.rootId}`,
                entityId: region.id
              });
            }
            const layoutAxes = region.layout.axisIds ?? [];
            if (
              region.layout.strategy === "timeline" &&
              (layoutAxes.length !== 1 ||
                view.structure.axes.find(({ id }) => id === layoutAxes[0])
                  ?.scale !== "temporal")
            ) {
              diagnostics.push({
                severity: "warning",
                code: "unsupported-timeline-region",
                message: `Region ${region.id} timeline layout requires exactly one temporal axis`,
                entityId: region.id
              });
            }
            if (region.layout.strategy === "matrix") {
              const axes = layoutAxes.flatMap((axisId) => {
                const axis = view.structure?.axes.find(({ id }) => id === axisId);
                return axis ? [axis] : [];
              });
              if (
                layoutAxes.length !== 2 ||
                !axes.some(({ orientation }) => orientation === "horizontal") ||
                !axes.some(({ orientation }) => orientation === "vertical")
              ) {
                diagnostics.push({
                  severity: "warning",
                  code: "unsupported-matrix-region",
                  message: `Region ${region.id} matrix layout requires one horizontal and one vertical axis`,
                  entityId: region.id
                });
              }
            }
          }
        }
        for (const [nodeId, mapping] of Object.entries(
          view.structure.nodeMappings
        )) {
          if (!nodeIds.has(nodeId)) {
            diagnostics.push({
              severity: "error",
              code: "missing-mapping-node",
              message: `View mapping references missing node: ${nodeId}`,
              entityId: view.id
            });
          }
          for (const regionId of mapping.regionIds) {
            if (!regionIds.has(regionId)) {
              diagnostics.push({
                severity: "error",
                code: "missing-mapping-region",
                message: `Node ${nodeId} references missing region ${regionId}`,
                entityId: nodeId
              });
            }
          }
          for (const [axisId, value] of Object.entries(mapping.axisValues ?? {})) {
            const axis = view.structure.axes.find(({ id }) => id === axisId);
            if (!axis) {
              diagnostics.push({
                severity: "error",
                code: "missing-mapping-axis",
                message: `Node ${nodeId} references missing axis ${axisId}`,
                entityId: nodeId
              });
            } else if (
              !axis.values.some(
                (entry) => primitiveKey(entry.value) === primitiveKey(value)
              )
            ) {
              diagnostics.push({
                severity: "error",
                code: "invalid-mapping-axis-value",
                message: `Node ${nodeId} uses a value outside axis ${axisId}`,
                entityId: nodeId
              });
            }
          }
          const layoutRegionIds = mapping.regionIds.filter((regionId) =>
            view.structure?.regions.some(
              (region) => region.id === regionId && region.layout
            )
          );
          if (layoutRegionIds.length > 1) {
            diagnostics.push({
              severity: "warning",
              code: "ambiguous-region-layout-membership",
              message: `Node ${nodeId} belongs to multiple layout-owning regions: ${layoutRegionIds.join(", ")}`,
              entityId: nodeId
            });
          }
    }
  }
  return diagnostics;
}

function hierarchyDiagnostics(
  document: GraphDocument,
  profile: GraphProfile
): Diagnostic[] {
  const constraints = profile.hierarchyConstraints;
  if (!constraints) return [];
  const hierarchyType = constraints.relationshipType;

  const diagnostics: Diagnostic[] = [];
  const hierarchy = document.relationships.filter(
    (relationship) => relationship.type === hierarchyType
  );
  const parentByNode = new Map<string, string>();

  for (const relationship of hierarchy) {
    const { parentId, childId } = hierarchyNodeIds(profile, relationship);
    const existingParent = parentByNode.get(childId);
    if (existingParent) {
      diagnostics.push({
        severity: "error",
        code: "multiple-hierarchy-parents",
        message: `${childId} already has hierarchy parent ${existingParent}`,
        entityId: childId
      });
    } else {
      parentByNode.set(childId, parentId);
    }
  }

  for (const node of document.nodes) {
    const path = new Set<string>();
    let current: string | undefined = node.id;
    while (current) {
      if (path.has(current)) {
        diagnostics.push({
          severity: "error",
          code: "hierarchy-cycle",
          message: `Hierarchy cycle includes ${current}`,
          entityId: current
        });
        break;
      }
      path.add(current);
      current = parentByNode.get(current);
    }
  }

  return diagnostics;
}

function propertyDiagnostic(
  entity: { id: string; type: string },
  entityKind: "node" | "relationship",
  definition: PropertyDefinition,
  value: JsonValue
): Diagnostic | undefined {
  const allowedTypes =
    entityKind === "node"
      ? definition.nodeTypes
      : definition.relationshipTypes;
  if (allowedTypes && !allowedTypes.includes(entity.type)) {
    return {
      severity: "error",
      code: `invalid-property-${entityKind}-type`,
      message: `${definition.key} is not allowed on ${entity.type}`,
      path: `/${entityKind === "node" ? "nodes" : "relationships"}/${entity.id}/properties/${definition.key}`,
      entityId: entity.id
    };
  }

  const validKind =
    (definition.kind === "string" && typeof value === "string") ||
    (definition.kind === "number" && typeof value === "number") ||
    (definition.kind === "boolean" && typeof value === "boolean") ||
    (definition.kind === "date" && isProfileDateValue(value));
  if (!validKind) {
    return {
      severity: "error",
      code: "invalid-property-kind",
      message: `${definition.key} must be a ${definition.kind}`,
      path: `/${entityKind === "node" ? "nodes" : "relationships"}/${entity.id}/properties/${definition.key}`,
      entityId: entity.id
    };
  }

  if (definition.values && !definition.values.includes(value)) {
    return {
      severity: "error",
      code: "invalid-property-value",
      message: `${String(value)} is not an allowed ${definition.key} value`,
      path: `/${entityKind === "node" ? "nodes" : "relationships"}/${entity.id}/properties/${definition.key}`,
      entityId: entity.id
    };
  }

  if (
    typeof value === "number" &&
    ((definition.minimum !== undefined && value < definition.minimum) ||
      (definition.maximum !== undefined && value > definition.maximum))
  ) {
    return {
      severity: "error",
      code: "property-out-of-range",
      message: `${definition.key} must be between ${definition.minimum ?? "-∞"} and ${definition.maximum ?? "∞"}`,
      path: `/${entityKind === "node" ? "nodes" : "relationships"}/${entity.id}/properties/${definition.key}`,
      entityId: entity.id
    };
  }

  return undefined;
}

function visualRuleDiagnostics(
  document: GraphDocument,
  profile: GraphProfile
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeTypes = new Set(profile.nodeTypes);
  const relationshipTypes = new Set(profile.relationshipTypes);
  const properties = new Map(
    profile.propertyDefinitions.map((definition) => [definition.key, definition])
  );
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const relationshipsById = new Map(
    document.relationships.map((relationship) => [relationship.id, relationship])
  );

  for (const view of document.views) {
    const rules = view.appearance?.visualRules ?? [];
    const seen = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      const path = `/views/${view.id}/appearance/visualRules/${index}`;
      if (seen.has(rule.id)) {
        diagnostics.push({
          severity: "error",
          code: "duplicate-visual-rule-id",
          message: `Duplicate visual rule ID: ${rule.id}`,
          path,
          entityId: view.id
        });
      }
      seen.add(rule.id);
      const allowedTypes =
        rule.target === "node" ? nodeTypes : relationshipTypes;
      for (const type of rule.entityTypes ?? []) {
        if (!allowedTypes.has(type)) {
          diagnostics.push({
            severity: "error",
            code: "unknown-visual-rule-entity-type",
            message: `${type} is not a declared ${rule.target} type.`,
            path: `${path}/entityTypes`,
            entityId: view.id
          });
        }
      }
      const conditionProperty = properties.get(rule.when.property);
      if (!conditionProperty) {
        diagnostics.push(
          rulePropertyDiagnostic(
            "unknown-visual-rule-property",
            rule.when.property,
            `${path}/when/property`,
            view.id
          )
        );
      } else {
        validateRulePropertyTarget(
          rule,
          conditionProperty,
          `${path}/when/property`,
          view.id,
          diagnostics
        );
        if (
          isOrderedOperator(rule.when.operator) &&
          conditionProperty.kind !== "number"
        ) {
          diagnostics.push({
            severity: "error",
            code: "invalid-visual-rule-operator",
            message: `${rule.when.operator} requires a numeric property.`,
            path: `${path}/when/operator`,
            entityId: view.id
          });
        }
        if (
          rule.when.operator !== "exists" &&
          !ruleValueMatchesKind(rule.when.value!, conditionProperty.kind)
        ) {
          diagnostics.push({
            severity: "error",
            code: "invalid-visual-rule-value",
            message: `Rule value must match the ${conditionProperty.kind} property kind.`,
            path: `${path}/when/value`,
            entityId: view.id
          });
        }
      }
      for (const [channel, property] of [
        ["text", rule.apply.text?.property],
        ["bar", rule.apply.bar?.property],
        ["badge", rule.apply.badge?.property]
      ] as const) {
        if (!property) continue;
        const definition = properties.get(property);
        if (!definition) {
          diagnostics.push(
            rulePropertyDiagnostic(
              "unknown-visual-output-property",
              property,
              `${path}/apply/${channel}/property`,
              view.id
            )
          );
          continue;
        }
        validateRulePropertyTarget(
          rule,
          definition,
          `${path}/apply/${channel}/property`,
          view.id,
          diagnostics
        );
        if (channel === "bar" && definition.kind !== "number") {
          diagnostics.push({
            severity: "error",
            code: "invalid-visual-bar-property",
            message: `${property} must be numeric to drive a bar.`,
            path: `${path}/apply/bar/property`,
            entityId: view.id
          });
        }
      }
      if (
        rule.apply.bar &&
        rule.apply.bar.maximum <= rule.apply.bar.minimum
      ) {
        diagnostics.push({
          severity: "error",
          code: "invalid-visual-bar-bounds",
          message: "Visual bar maximum must be greater than minimum.",
          path: `${path}/apply/bar`,
          entityId: view.id
        });
      }
    }
    for (const nodeId of Object.keys(
      view.appearance?.nodeVisualOverrides ?? {}
    )) {
      const node = nodesById.get(nodeId);
      if (!node) {
        diagnostics.push({
          severity: "error",
          code: "missing-visual-override-node",
          message: `Visual override references missing node: ${nodeId}`,
          path: `/views/${view.id}/appearance/nodeVisualOverrides/${nodeId}`,
          entityId: view.id
        });
      } else {
        validateOverrideOutput(
          view.appearance!.nodeVisualOverrides![nodeId]!,
          "node",
          node.type,
          `/views/${view.id}/appearance/nodeVisualOverrides/${nodeId}`,
          view.id,
          properties,
          diagnostics
        );
      }
    }
    for (const relationshipId of Object.keys(
      view.appearance?.relationshipVisualOverrides ?? {}
    )) {
      const relationship = relationshipsById.get(relationshipId);
      if (!relationship) {
        diagnostics.push({
          severity: "error",
          code: "missing-visual-override-relationship",
          message: `Visual override references missing relationship: ${relationshipId}`,
          path: `/views/${view.id}/appearance/relationshipVisualOverrides/${relationshipId}`,
          entityId: view.id
        });
      } else {
        validateOverrideOutput(
          view.appearance!.relationshipVisualOverrides![relationshipId]!,
          "relationship",
          relationship.type,
          `/views/${view.id}/appearance/relationshipVisualOverrides/${relationshipId}`,
          view.id,
          properties,
          diagnostics
        );
      }
    }

    function validateOverrideOutput(
      output: VisualEncodingRule["apply"],
      target: VisualEncodingRule["target"],
      entityType: string,
      path: string,
      viewId: string,
      properties: ReadonlyMap<string, PropertyDefinition>,
      diagnostics: Diagnostic[]
    ): void {
      for (const [channel, property] of [
        ["text", output.text?.property],
        ["bar", output.bar?.property],
        ["badge", output.badge?.property]
      ] as const) {
        if (!property) continue;
        const definition = properties.get(property);
        if (!definition) {
          diagnostics.push(
            rulePropertyDiagnostic(
              "unknown-visual-output-property",
              property,
              `${path}/${channel}/property`,
              viewId
            )
          );
          continue;
        }
        const allowed =
          target === "node"
            ? definition.nodeTypes
            : definition.relationshipTypes;
        const opposite =
          target === "node"
            ? definition.relationshipTypes
            : definition.nodeTypes;
        if (
          (opposite && allowed === undefined) ||
          (allowed && !allowed.includes(entityType))
        ) {
          diagnostics.push({
            severity: "error",
            code: "invalid-visual-rule-property-target",
            message: `${property} is not declared for ${entityType}.`,
            path: `${path}/${channel}/property`,
            entityId: viewId
          });
        }
        if (channel === "bar" && definition.kind !== "number") {
          diagnostics.push({
            severity: "error",
            code: "invalid-visual-bar-property",
            message: `${property} must be numeric to drive a bar.`,
            path: `${path}/bar/property`,
            entityId: viewId
          });
        }
      }
      if (output.bar && output.bar.maximum <= output.bar.minimum) {
        diagnostics.push({
          severity: "error",
          code: "invalid-visual-bar-bounds",
          message: "Visual bar maximum must be greater than minimum.",
          path: `${path}/bar`,
          entityId: viewId
        });
      }
    }
  }
  return diagnostics;
}

function rulePropertyDiagnostic(
  code: string,
  property: string,
  path: string,
  viewId: string
): Diagnostic {
  return {
    severity: "error",
    code,
    message: `${property} is not declared by the active profile.`,
    path,
    entityId: viewId
  };
}

function validateRulePropertyTarget(
  rule: VisualEncodingRule,
  definition: PropertyDefinition,
  path: string,
  viewId: string,
  diagnostics: Diagnostic[]
): void {
  const allowed =
    rule.target === "node"
      ? definition.nodeTypes
      : definition.relationshipTypes;
  const opposite =
    rule.target === "node"
      ? definition.relationshipTypes
      : definition.nodeTypes;
  if (opposite && allowed === undefined) {
    diagnostics.push({
      severity: "error",
      code: "invalid-visual-rule-property-target",
      message: `${definition.key} is not declared for ${rule.target} data.`,
      path,
      entityId: viewId
    });
    return;
  }
  if (
    allowed &&
    (rule.entityTypes === undefined ||
      rule.entityTypes.some((type) => !allowed.includes(type)))
  ) {
    diagnostics.push({
      severity: "error",
      code: "invalid-visual-rule-property-target",
      message: `${definition.key} requires the rule to target only its declared entity types.`,
      path,
      entityId: viewId
    });
  }
}

function isOrderedOperator(
  operator: VisualEncodingRule["when"]["operator"]
): boolean {
  return [
    "greater-than",
    "greater-than-or-equal",
    "less-than",
    "less-than-or-equal"
  ].includes(operator);
}

function ruleValueMatchesKind(
  value: JsonValue,
  kind: PropertyDefinition["kind"]
): boolean {
  return (
    (kind === "string" && typeof value === "string") ||
    (kind === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (kind === "boolean" && typeof value === "boolean") ||
    (kind === "date" && isProfileDateValue(value))
  );
}

export function validateCanonicalDocument(input: unknown): ValidationResult {
  if (!validateSchema(input)) {
    return {
      valid: false,
      diagnostics: (validateSchema.errors ?? []).map(schemaDiagnostic)
    };
  }

  const document = input;
  const diagnostics: Diagnostic[] = [
    ...duplicateDiagnostics(
      document.nodes.map((node) => node.id),
      "node"
    ),
    ...duplicateDiagnostics(
      document.relationships.map((relationship) => relationship.id),
      "relationship"
    ),
    ...duplicateDiagnostics(
      document.views.map((view) => view.id),
      "view"
    )
  ];
  diagnostics.push(...richResourceDiagnostics(document));

  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const relationshipIds = new Set(
    document.relationships.map((relationship) => relationship.id)
  );
  for (const relationship of document.relationships) {
    if (!nodeIds.has(relationship.source)) {
      diagnostics.push({
        severity: "error",
        code: "missing-relationship-source",
        message: `Relationship source does not exist: ${relationship.source}`,
        entityId: relationship.id
      });
    }
    if (!nodeIds.has(relationship.target)) {
      diagnostics.push({
        severity: "error",
        code: "missing-relationship-target",
        message: `Relationship target does not exist: ${relationship.target}`,
        entityId: relationship.id
      });
    }
  }

  for (const view of document.views) {
    for (const nodeId of Object.keys(view.placements)) {
      if (!nodeIds.has(nodeId)) {
        diagnostics.push({
          severity: "error",
          code: "missing-placement-node",
          message: `Placement references missing node: ${nodeId}`,
          entityId: view.id
        });
      }
    }
    for (const relationshipId of Object.keys(view.routes ?? {})) {
      if (!relationshipIds.has(relationshipId)) {
        diagnostics.push({
          severity: "error",
          code: "missing-route-relationship",
          message: `Route references missing relationship: ${relationshipId}`,
          path: `/views/${view.id}/routes/${relationshipId}`,
          entityId: relationshipId
        });
      }
    }
  }
  diagnostics.push(...viewStructureDiagnostics(document));

  return {
    valid: diagnostics.every(
      (diagnostic) => diagnostic.severity !== "error"
    ),
    diagnostics
  };
}

export function validateDocumentProfile(
  document: GraphDocument,
  profilePackage?: ProfilePackage
): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const reference = readProfilePackageReference(document.extensions);
  if (
    Object.hasOwn(document.extensions ?? {}, "profilePackage") &&
    reference === undefined
  ) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-profile-package-reference",
      path: "/extensions/profilePackage",
      message:
        "The pinned profile package reference is malformed; profile validation used the compatible installed package."
    });
  } else if (reference && reference.id !== document.document.profile) {
    diagnostics.push({
      severity: "warning",
      code: "profile-package-reference-mismatch",
      path: "/extensions/profilePackage/id",
      message: `Pinned profile ${reference.id} does not match document profile ${document.document.profile}; profile validation used the compatible installed package.`
    });
  }
  const resolution = profilePackage
    ? {
        ok: true as const,
        package: profilePackage,
        profile: materializeProfile(profilePackage)
      }
    : resolveDocumentProfile(document);
  if (!resolution.ok) {
    diagnostics.push({
      severity: "warning",
      code: resolution.code,
      path: "/document/profile",
      message: `${resolution.message} The document remains available for safe inspection with custom type fallbacks.`
    });
    return { valid: true, diagnostics };
  }
  const profile = resolution.profile;
  if (profile.id !== document.document.profile) {
    diagnostics.push({
      severity: "error",
      code: "profile-package-id-mismatch",
      path: "/document/profile",
      message: `Profile package ${profile.id}@${profile.version} cannot validate document profile ${document.document.profile}.`
    });
    return { valid: false, diagnostics };
  }

  for (const node of document.nodes) {
    if (!profile.nodeTypes.includes(node.type)) {
      diagnostics.push({
        severity: "error",
        code: "invalid-node-type",
        message: `${node.type} is not allowed by ${profile.id}`,
        entityId: node.id
      });
    }
    for (const definition of profile.propertyDefinitions) {
      if (
        definition.relationshipTypes &&
        definition.nodeTypes === undefined
      ) {
        continue;
      }
      const applies =
        definition.nodeTypes === undefined ||
        definition.nodeTypes.includes(node.type);
      if (
        definition.required &&
        applies &&
        !Object.hasOwn(node.properties, definition.key)
      ) {
        diagnostics.push({
          severity: "error",
          code: "missing-required-property",
          message: `${definition.key} is required on ${node.type}`,
          path: `/nodes/${node.id}/properties/${definition.key}`,
          entityId: node.id
        });
        continue;
      }
      if (!Object.hasOwn(node.properties, definition.key)) continue;
      const diagnostic = propertyDiagnostic(
        node,
        "node",
        definition,
        node.properties[definition.key]!
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  for (const relationship of document.relationships) {
    if (!profile.relationshipTypes.includes(relationship.type)) {
      diagnostics.push({
        severity: "error",
        code: "invalid-relationship-type",
        message: `${relationship.type} is not allowed by ${profile.id}`,
        entityId: relationship.id
      });
      continue;
    }
    const definition = profile.relationshipTypeDefinitions.find(
      ({ id }) => id === relationship.type
    );
    if (definition) {
      diagnostics.push(
        ...relationshipConstraintDiagnostics(
          relationship,
          definition,
          nodesById
        )
      );
    }
    for (const property of profile.propertyDefinitions) {
      if (
        property.nodeTypes &&
        property.relationshipTypes === undefined
      ) {
        continue;
      }
      const applies =
        property.relationshipTypes === undefined ||
        property.relationshipTypes.includes(relationship.type);
      if (
        property.required &&
        applies &&
        !Object.hasOwn(relationship.properties, property.key)
      ) {
        diagnostics.push({
          severity: "error",
          code: "missing-required-property",
          message: `${property.key} is required on ${relationship.type}`,
          path: `/relationships/${relationship.id}/properties/${property.key}`,
          entityId: relationship.id
        });
        continue;
      }
      if (!Object.hasOwn(relationship.properties, property.key)) continue;
      const diagnostic = propertyDiagnostic(
        relationship,
        "relationship",
        property,
        relationship.properties[property.key]!
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  diagnostics.push(
    ...hierarchyDiagnostics(document, profile),
    ...visualRuleDiagnostics(document, profile)
  );
  return {
    valid: diagnostics.every(
      (diagnostic) => diagnostic.severity !== "error"
    ),
    diagnostics
  };
}

function relationshipConstraintDiagnostics(
  relationship: GraphRelationship,
  definition: GraphProfile["relationshipTypeDefinitions"][number],
  nodesById: ReadonlyMap<string, GraphDocument["nodes"][number]>
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (definition.allowSelf === false && relationship.source === relationship.target) {
    diagnostics.push({
      severity: "error",
      code: "self-relationship-not-allowed",
      message: `${relationship.type} does not allow a node to relate to itself`,
      entityId: relationship.id
    });
  }
  const source = nodesById.get(relationship.source);
  if (
    source &&
    definition.sourceNodeTypes &&
    !definition.sourceNodeTypes.includes(source.type)
  ) {
    diagnostics.push({
      severity: "error",
      code: "invalid-relationship-source-type",
      message: `${relationship.type} cannot start at ${source.type}`,
      entityId: relationship.id
    });
  }
  const target = nodesById.get(relationship.target);
  if (
    target &&
    definition.targetNodeTypes &&
    !definition.targetNodeTypes.includes(target.type)
  ) {
    diagnostics.push({
      severity: "error",
      code: "invalid-relationship-target-type",
      message: `${relationship.type} cannot end at ${target.type}`,
      entityId: relationship.id
    });
  }
  return diagnostics;
}

export function validateDocument(input: unknown): ValidationResult {
  const canonical = validateCanonicalDocument(input);
  if (!canonical.valid) return canonical;
  const profile = validateDocumentProfile(input as GraphDocument);
  return {
    valid: profile.valid,
    diagnostics: [...canonical.diagnostics, ...profile.diagnostics]
  };
}

export function assertValidDocument(input: unknown): asserts input is GraphDocument {
  const result = validateDocument(input);
  if (!result.valid) {
    const details = result.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    throw new Error(`Invalid graph document:\n${details}`);
  }
}
