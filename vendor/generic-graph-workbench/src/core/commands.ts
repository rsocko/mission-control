import {
  getProfile,
  hierarchyNodeIds,
  hierarchyRelationshipEndpoints
} from "./profiles.js";
import type {
  GraphDocument,
  GraphNode,
  GraphRelationship,
  GraphView,
  JsonValue,
  Placement,
  RelationshipRoute,
  ViewNodeMapping,
  VisualRuleOutput
} from "./types.js";
import { validateDocument } from "./validation.js";

interface NodeSnapshot {
  nodeIndex: number;
  node: GraphNode;
  relationships: Array<{
    index: number;
    relationship: GraphRelationship;
  }>;
  placements: Record<string, Placement>;
  routes: Record<string, Record<string, RelationshipRoute>>;
  mappings: Record<string, ViewNodeMapping>;
  nodeVisualOverrides: Record<string, VisualRuleOutput>;
  relationshipVisualOverrides: Record<string, Record<string, VisualRuleOutput>>;
}

interface RelationshipSnapshot {
  relationship: GraphRelationship;
  index: number;
  routes: Record<string, RelationshipRoute>;
  visualOverrides: Record<string, VisualRuleOutput>;
}

interface RelationshipState {
  relationship: GraphRelationship;
  routes: Record<string, RelationshipRoute>;
}

type RouteSnapshotsByRelationship = Record<
  string,
  Record<string, RelationshipRoute>
>;
type VisualOverrideSnapshotsByRelationship = Record<
  string,
  Record<string, VisualRuleOutput>
>;

interface PlacementState {
  placement?: Placement;
  routes: Record<string, RelationshipRoute>;
}

export type GraphCommand =
  | { type: "create-node"; node: GraphNode; index?: number }
  | { type: "update-node"; node: GraphNode }
  | { type: "delete-node"; nodeId: string }
  | { type: "restore-node"; snapshot: NodeSnapshot }
  | { type: "create-relationship"; relationship: GraphRelationship }
  | { type: "update-relationship"; relationship: GraphRelationship }
  | { type: "restore-relationship-state"; state: RelationshipState }
  | { type: "delete-relationship"; relationshipId: string }
  | {
      type: "restore-relationship";
      snapshot: RelationshipSnapshot;
    }
  | {
      type: "set-property";
      nodeId: string;
      key: string;
      value: JsonValue;
    }
  | { type: "unset-property"; nodeId: string; key: string }
  | {
      type: "set-placement";
      viewId: string;
      nodeId: string;
      placement: Placement;
    }
  | {
      type: "set-placement-only";
      viewId: string;
      nodeId: string;
      placement: Placement;
    }
  | { type: "remove-placement"; viewId: string; nodeId: string }
  | {
      type: "restore-placement-state";
      viewId: string;
      nodeId: string;
      state: PlacementState;
    }
  | {
      type: "set-relationship-route";
      viewId: string;
      relationshipId: string;
      route: RelationshipRoute;
    }
  | {
      type: "remove-relationship-route";
      viewId: string;
      relationshipId: string;
    }
  | { type: "create-view"; view: GraphView }
  | { type: "update-view"; view: GraphView }
  | { type: "delete-view"; viewId: string }
  | { type: "restore-view"; view: GraphView; index: number }
  | { type: "replace-document"; document: GraphDocument }
  | {
      type: "move-in-hierarchy";
      nodeId: string;
      parentId: string | null;
      relationshipId?: string;
    }
  | {
      type: "restore-hierarchy";
      nodeId: string;
      relationships: Array<{
        index: number;
        relationship: GraphRelationship;
      }>;
      routes: RouteSnapshotsByRelationship;
      visualOverrides: VisualOverrideSnapshotsByRelationship;
    };

export interface BatchResult {
  document: GraphDocument;
  inverse: GraphCommand[];
}

function requireNode(document: GraphDocument, nodeId: string): GraphNode {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function requireView(document: GraphDocument, viewId: string): GraphView {
  const view = document.views.find((candidate) => candidate.id === viewId);
  if (!view) throw new Error(`View not found: ${viewId}`);
  return view;
}

function requireRelationship(
  document: GraphDocument,
  relationshipId: string
): GraphRelationship {
  const relationship = document.relationships.find(
    (candidate) => candidate.id === relationshipId
  );
  if (!relationship) {
    throw new Error(`Relationship not found: ${relationshipId}`);
  }
  return relationship;
}

function connectedRouteState(
  document: GraphDocument,
  view: GraphView,
  nodeId: string
): Record<string, RelationshipRoute> {
  return Object.fromEntries(
    document.relationships.flatMap((relationship) => {
      const route = view.routes?.[relationship.id];
      return route &&
        (relationship.source === nodeId || relationship.target === nodeId)
        ? [[relationship.id, route] as const]
        : [];
    })
  );
}

function clearConnectedRoutes(
  document: GraphDocument,
  view: GraphView,
  nodeId: string
): void {
  if (!view.routes) return;
  for (const relationship of document.relationships) {
    if (relationship.source === nodeId || relationship.target === nodeId) {
      delete view.routes[relationship.id];
    }
  }
  if (Object.keys(view.routes).length === 0) delete view.routes;
}

function relationshipRouteState(
  document: GraphDocument,
  relationshipId: string
): Record<string, RelationshipRoute> {
  return Object.fromEntries(
    document.views.flatMap((view) => {
      const route = view.routes?.[relationshipId];
      return route ? [[view.id, route] as const] : [];
    })
  );
}

function clearRelationshipRoutes(
  document: GraphDocument,
  relationshipId: string
): void {
  for (const view of document.views) {
    if (!view.routes) continue;
    delete view.routes[relationshipId];
    if (Object.keys(view.routes).length === 0) delete view.routes;
  }
}

function restoreRelationshipRoutes(
  document: GraphDocument,
  relationshipId: string,
  routes: Record<string, RelationshipRoute>
): void {
  for (const [viewId, route] of Object.entries(routes)) {
    const view = requireView(document, viewId);
    view.routes = {
      ...(view.routes ?? {}),
      [relationshipId]: structuredClone(route)
    };
  }
}

function relationshipVisualOverrideState(
  document: GraphDocument,
  relationshipId: string
): Record<string, VisualRuleOutput> {
  return Object.fromEntries(
    document.views.flatMap((view) => {
      const visual =
        view.appearance?.relationshipVisualOverrides?.[relationshipId];
      return visual ? [[view.id, visual] as const] : [];
    })
  );
}

function clearRelationshipVisualOverrides(
  document: GraphDocument,
  relationshipId: string
): void {
  for (const view of document.views) {
    const overrides = view.appearance?.relationshipVisualOverrides;
    if (!overrides) continue;
    delete overrides[relationshipId];
    if (Object.keys(overrides).length === 0) {
      delete view.appearance!.relationshipVisualOverrides;
    }
  }
}

function restoreRelationshipVisualOverrides(
  document: GraphDocument,
  relationshipId: string,
  visualOverrides: Record<string, VisualRuleOutput>
): void {
  for (const [viewId, visual] of Object.entries(visualOverrides)) {
    const view = requireView(document, viewId);
    view.appearance ??= {};
    view.appearance.relationshipVisualOverrides = {
      ...(view.appearance.relationshipVisualOverrides ?? {}),
      [relationshipId]: structuredClone(visual)
    };
  }
}

function applyCommand(
  document: GraphDocument,
  command: GraphCommand
): GraphCommand | undefined {
  switch (command.type) {
    case "create-node": {
      if (document.nodes.some((node) => node.id === command.node.id)) {
        throw new Error(`Node already exists: ${command.node.id}`);
      }
      const index =
        command.index === undefined ? document.nodes.length : command.index;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index > document.nodes.length
      ) {
        throw new Error(
          `Node insertion index must be an integer between 0 and ${document.nodes.length}: ${index}`
        );
      }
      document.nodes.splice(index, 0, structuredClone(command.node));
      return { type: "delete-node", nodeId: command.node.id };
    }
    case "update-node": {
      const index = document.nodes.findIndex(
        (node) => node.id === command.node.id
      );
      if (index < 0) throw new Error(`Node not found: ${command.node.id}`);
      const previous = document.nodes[index]!;
      document.nodes[index] = structuredClone(command.node);
      return { type: "update-node", node: previous };
    }
    case "delete-node": {
      const index = document.nodes.findIndex(
        (node) => node.id === command.nodeId
      );
      if (index < 0) throw new Error(`Node not found: ${command.nodeId}`);
      const node = document.nodes[index]!;
      const relationships = document.relationships.flatMap(
        (relationship, relationshipIndex) =>
          relationship.source === command.nodeId ||
          relationship.target === command.nodeId
            ? [{ index: relationshipIndex, relationship }]
            : []
      );
      const placements: Record<string, Placement> = {};
      const routes: Record<string, Record<string, RelationshipRoute>> = {};
      const mappings: Record<string, ViewNodeMapping> = {};
      const nodeVisualOverrides: Record<string, VisualRuleOutput> = {};
      const relationshipVisualOverrides: Record<
        string,
        Record<string, VisualRuleOutput>
      > = {};
      const relationshipIds = new Set(
        relationships.map(({ relationship }) => relationship.id)
      );
      for (const view of document.views) {
        const placement = view.placements[command.nodeId];
        if (placement) {
          placements[view.id] = placement;
          delete view.placements[command.nodeId];
        }
        const mapping = view.structure?.nodeMappings[command.nodeId];
        if (mapping) {
          mappings[view.id] = mapping;
          delete view.structure!.nodeMappings[command.nodeId];
        }
        const viewRoutes = Object.fromEntries(
          Object.entries(view.routes ?? {}).filter(([relationshipId]) =>
            relationshipIds.has(relationshipId)
          )
        );
        if (Object.keys(viewRoutes).length > 0) routes[view.id] = viewRoutes;
        if (view.routes) {
          for (const relationshipId of relationshipIds) {
            delete view.routes[relationshipId];
          }
          if (Object.keys(view.routes).length === 0) delete view.routes;
        }
        const nodeVisualOverride =
          view.appearance?.nodeVisualOverrides?.[command.nodeId];
        if (nodeVisualOverride) {
          nodeVisualOverrides[view.id] = nodeVisualOverride;
          delete view.appearance!.nodeVisualOverrides![command.nodeId];
          if (
            Object.keys(view.appearance!.nodeVisualOverrides!).length === 0
          ) {
            delete view.appearance!.nodeVisualOverrides;
          }
        }
        const viewRelationshipVisualOverrides = Object.fromEntries(
          Object.entries(
            view.appearance?.relationshipVisualOverrides ?? {}
          ).filter(([relationshipId]) => relationshipIds.has(relationshipId))
        );
        if (Object.keys(viewRelationshipVisualOverrides).length > 0) {
          relationshipVisualOverrides[view.id] =
            viewRelationshipVisualOverrides;
          for (const relationshipId of relationshipIds) {
            delete view.appearance!.relationshipVisualOverrides![relationshipId];
          }
          if (
            Object.keys(view.appearance!.relationshipVisualOverrides!).length ===
              0
          ) {
            delete view.appearance!.relationshipVisualOverrides;
          }
        }
      }
      document.nodes.splice(index, 1);
      document.relationships = document.relationships.filter(
        (relationship) =>
          relationship.source !== command.nodeId &&
          relationship.target !== command.nodeId
      );
      return {
        type: "restore-node",
        snapshot: {
          nodeIndex: index,
          node,
          relationships,
          placements,
          routes,
          mappings,
          nodeVisualOverrides,
          relationshipVisualOverrides
        }
      };
    }
    case "restore-node": {
      if (
        document.nodes.some(
          (node) => node.id === command.snapshot.node.id
        )
      ) {
        throw new Error(`Node already exists: ${command.snapshot.node.id}`);
      }
      document.nodes.splice(
        command.snapshot.nodeIndex,
        0,
        structuredClone(command.snapshot.node)
      );
      for (const entry of [...command.snapshot.relationships].sort(
        (left, right) => left.index - right.index
      )) {
        document.relationships.splice(
          entry.index,
          0,
          structuredClone(entry.relationship)
        );
      }
      for (const [viewId, placement] of Object.entries(
        command.snapshot.placements
      )) {
        requireView(document, viewId).placements[command.snapshot.node.id] =
          structuredClone(placement);
      }
      for (const [viewId, routes] of Object.entries(command.snapshot.routes)) {
        const view = requireView(document, viewId);
        view.routes = {
          ...(view.routes ?? {}),
          ...structuredClone(routes)
        };
      }
      for (const [viewId, mapping] of Object.entries(command.snapshot.mappings)) {
        const view = requireView(document, viewId);
        if (!view.structure) {
          throw new Error(`View structure not found: ${viewId}`);
        }
        view.structure.nodeMappings[command.snapshot.node.id] =
          structuredClone(mapping);
      }
      for (const [viewId, visual] of Object.entries(
        command.snapshot.nodeVisualOverrides
      )) {
        const view = requireView(document, viewId);
        view.appearance ??= {};
        view.appearance.nodeVisualOverrides = {
          ...(view.appearance.nodeVisualOverrides ?? {}),
          [command.snapshot.node.id]: structuredClone(visual)
        };
      }
      for (const [viewId, visualOverrides] of Object.entries(
        command.snapshot.relationshipVisualOverrides
      )) {
        const view = requireView(document, viewId);
        view.appearance ??= {};
        view.appearance.relationshipVisualOverrides = {
          ...(view.appearance.relationshipVisualOverrides ?? {}),
          ...structuredClone(visualOverrides)
        };
      }
      return { type: "delete-node", nodeId: command.snapshot.node.id };
    }
    case "create-relationship": {
      if (
        document.relationships.some(
          (relationship) => relationship.id === command.relationship.id
        )
      ) {
        throw new Error(
          `Relationship already exists: ${command.relationship.id}`
        );
      }
      document.relationships.push(structuredClone(command.relationship));
      return {
        type: "delete-relationship",
        relationshipId: command.relationship.id
      };
    }
    case "update-relationship": {
      const index = document.relationships.findIndex(
        (relationship) => relationship.id === command.relationship.id
      );
      if (index < 0) {
        throw new Error(`Relationship not found: ${command.relationship.id}`);
      }
      const previous = document.relationships[index]!;
      const endpointsChanged =
        previous.source !== command.relationship.source ||
        previous.target !== command.relationship.target;
      if (!endpointsChanged) {
        document.relationships[index] = structuredClone(command.relationship);
        return { type: "update-relationship", relationship: previous };
      }
      const routes = relationshipRouteState(document, previous.id);
      document.relationships[index] = structuredClone(command.relationship);
      clearRelationshipRoutes(document, previous.id);
      return {
        type: "restore-relationship-state",
        state: { relationship: previous, routes }
      };
    }
    case "restore-relationship-state": {
      const index = document.relationships.findIndex(
        (relationship) => relationship.id === command.state.relationship.id
      );
      if (index < 0) {
        throw new Error(
          `Relationship not found: ${command.state.relationship.id}`
        );
      }
      const relationship = document.relationships[index]!;
      const routes = relationshipRouteState(document, relationship.id);
      document.relationships[index] = structuredClone(
        command.state.relationship
      );
      clearRelationshipRoutes(document, relationship.id);
      restoreRelationshipRoutes(
        document,
        command.state.relationship.id,
        command.state.routes
      );
      return {
        type: "restore-relationship-state",
        state: { relationship, routes }
      };
    }
    case "delete-relationship": {
      const index = document.relationships.findIndex(
        (relationship) => relationship.id === command.relationshipId
      );
      if (index < 0) {
        throw new Error(
          `Relationship not found: ${command.relationshipId}`
        );
      }
      const relationship = document.relationships[index]!;
      const routes: Record<string, RelationshipRoute> = {};
      const visualOverrides: Record<string, VisualRuleOutput> = {};
      for (const view of document.views) {
        const route = view.routes?.[command.relationshipId];
        if (route) routes[view.id] = route;
        if (view.routes) {
          delete view.routes[command.relationshipId];
          if (Object.keys(view.routes).length === 0) delete view.routes;
        }
        const visualOverride =
          view.appearance?.relationshipVisualOverrides?.[command.relationshipId];
        if (visualOverride) {
          visualOverrides[view.id] = visualOverride;
          delete view.appearance!.relationshipVisualOverrides![
            command.relationshipId
          ];
          if (
            Object.keys(view.appearance!.relationshipVisualOverrides!).length ===
              0
          ) {
            delete view.appearance!.relationshipVisualOverrides;
          }
        }
      }
      document.relationships.splice(index, 1);
      return {
        type: "restore-relationship",
        snapshot: { relationship, index, routes, visualOverrides }
      };
    }
    case "restore-relationship": {
      if (
        document.relationships.some(
          (relationship) =>
            relationship.id === command.snapshot.relationship.id
        )
      ) {
        throw new Error(
          `Relationship already exists: ${command.snapshot.relationship.id}`
        );
      }
      document.relationships.splice(
        command.snapshot.index,
        0,
        structuredClone(command.snapshot.relationship)
      );
      for (const [viewId, route] of Object.entries(command.snapshot.routes)) {
        const view = requireView(document, viewId);
        view.routes = {
          ...(view.routes ?? {}),
          [command.snapshot.relationship.id]: structuredClone(route)
        };
      }
      for (const [viewId, visual] of Object.entries(
        command.snapshot.visualOverrides
      )) {
        const view = requireView(document, viewId);
        view.appearance ??= {};
        view.appearance.relationshipVisualOverrides = {
          ...(view.appearance.relationshipVisualOverrides ?? {}),
          [command.snapshot.relationship.id]: structuredClone(visual)
        };
      }
      return {
        type: "delete-relationship",
        relationshipId: command.snapshot.relationship.id
      };
    }
    case "set-property": {
      const node = requireNode(document, command.nodeId);
      const existed = Object.hasOwn(node.properties, command.key);
      const previous = node.properties[command.key];
      node.properties[command.key] = structuredClone(command.value);
      return existed
        ? {
            type: "set-property",
            nodeId: command.nodeId,
            key: command.key,
            value: previous!
          }
        : {
            type: "unset-property",
            nodeId: command.nodeId,
            key: command.key
          };
    }
    case "unset-property": {
      const node = requireNode(document, command.nodeId);
      if (!Object.hasOwn(node.properties, command.key)) {
        throw new Error(
          `Property not found: ${command.nodeId}.${command.key}`
        );
      }
      const previous = node.properties[command.key]!;
      delete node.properties[command.key];
      return {
        type: "set-property",
        nodeId: command.nodeId,
        key: command.key,
        value: previous
      };
    }
    case "set-placement": {
      requireNode(document, command.nodeId);
      const view = requireView(document, command.viewId);
      const previous = view.placements[command.nodeId];
      const routes = connectedRouteState(document, view, command.nodeId);
      view.placements[command.nodeId] = structuredClone(command.placement);
      clearConnectedRoutes(document, view, command.nodeId);
      return {
        type: "restore-placement-state",
        viewId: command.viewId,
        nodeId: command.nodeId,
        state: {
          ...(previous ? { placement: previous } : {}),
          routes
        }
      };
    }
    case "set-placement-only": {
      requireNode(document, command.nodeId);
      const view = requireView(document, command.viewId);
      const previous = view.placements[command.nodeId];
      if (!previous) {
        throw new Error(
          `Placement not found: ${command.viewId}.${command.nodeId}`
        );
      }
      view.placements[command.nodeId] = structuredClone(command.placement);
      return {
        type: "set-placement-only",
        viewId: command.viewId,
        nodeId: command.nodeId,
        placement: previous
      };
    }
    case "remove-placement": {
      const view = requireView(document, command.viewId);
      const previous = view.placements[command.nodeId];
      if (!previous) {
        throw new Error(
          `Placement not found: ${command.viewId}.${command.nodeId}`
        );
      }
      const routes = connectedRouteState(document, view, command.nodeId);
      delete view.placements[command.nodeId];
      clearConnectedRoutes(document, view, command.nodeId);
      return {
        type: "restore-placement-state",
        viewId: command.viewId,
        nodeId: command.nodeId,
        state: { placement: previous, routes }
      };
    }
    case "restore-placement-state": {
      requireNode(document, command.nodeId);
      const view = requireView(document, command.viewId);
      const placement = view.placements[command.nodeId];
      const routes = connectedRouteState(document, view, command.nodeId);
      if (command.state.placement) {
        view.placements[command.nodeId] = structuredClone(
          command.state.placement
        );
      } else {
        delete view.placements[command.nodeId];
      }
      clearConnectedRoutes(document, view, command.nodeId);
      if (Object.keys(command.state.routes).length > 0) {
        view.routes = {
          ...(view.routes ?? {}),
          ...structuredClone(command.state.routes)
        };
      }
      return {
        type: "restore-placement-state",
        viewId: command.viewId,
        nodeId: command.nodeId,
        state: {
          ...(placement ? { placement } : {}),
          routes
        }
      };
    }
    case "set-relationship-route": {
      requireRelationship(document, command.relationshipId);
      const view = requireView(document, command.viewId);
      const previous = view.routes?.[command.relationshipId];
      view.routes = {
        ...(view.routes ?? {}),
        [command.relationshipId]: structuredClone(command.route)
      };
      return previous
        ? {
            type: "set-relationship-route",
            viewId: command.viewId,
            relationshipId: command.relationshipId,
            route: previous
          }
        : {
            type: "remove-relationship-route",
            viewId: command.viewId,
            relationshipId: command.relationshipId
          };
    }
    case "remove-relationship-route": {
      requireRelationship(document, command.relationshipId);
      const view = requireView(document, command.viewId);
      const previous = view.routes?.[command.relationshipId];
      if (!previous) {
        throw new Error(
          `Relationship route not found: ${command.viewId}.${command.relationshipId}`
        );
      }
      delete view.routes![command.relationshipId];
      if (Object.keys(view.routes!).length === 0) delete view.routes;
      return {
        type: "set-relationship-route",
        viewId: command.viewId,
        relationshipId: command.relationshipId,
        route: previous
      };
    }
    case "create-view": {
      if (document.views.some((view) => view.id === command.view.id)) {
        throw new Error(`View already exists: ${command.view.id}`);
      }
      document.views.push(structuredClone(command.view));
      return { type: "delete-view", viewId: command.view.id };
    }
    case "update-view": {
      const index = document.views.findIndex(
        (view) => view.id === command.view.id
      );
      if (index < 0) throw new Error(`View not found: ${command.view.id}`);
      const previous = document.views[index]!;
      document.views[index] = structuredClone(command.view);
      return { type: "update-view", view: previous };
    }
    case "delete-view": {
      const index = document.views.findIndex(
        (view) => view.id === command.viewId
      );
      if (index < 0) throw new Error(`View not found: ${command.viewId}`);
      const view = document.views[index]!;
      document.views.splice(index, 1);
      return { type: "restore-view", view, index };
    }
    case "restore-view": {
      if (document.views.some((view) => view.id === command.view.id)) {
        throw new Error(`View already exists: ${command.view.id}`);
      }
      document.views.splice(
        command.index,
        0,
        structuredClone(command.view)
      );
      return { type: "delete-view", viewId: command.view.id };
    }
    case "replace-document": {
      const previous = structuredClone(document);
      const replacement = structuredClone(command.document);
      document.format = replacement.format;
      document.version = replacement.version;
      document.document = replacement.document;
      document.nodes = replacement.nodes;
      document.relationships = replacement.relationships;
      document.views = replacement.views;
      if (replacement.extensions) {
        document.extensions = replacement.extensions;
      } else {
        delete document.extensions;
      }
      return { type: "replace-document", document: previous };
    }
    case "move-in-hierarchy": {
      requireNode(document, command.nodeId);
      if (command.parentId) requireNode(document, command.parentId);
      const profile = getProfile(document);
      const hierarchyType = profile.hierarchyRelationship;
      if (!hierarchyType) {
        throw new Error(
          `${document.document.profile} does not define a hierarchy`
        );
      }
      const previous = document.relationships.flatMap(
        (relationship, index) =>
          relationship.type === hierarchyType &&
          hierarchyNodeIds(profile, relationship).childId === command.nodeId
            ? [{ index, relationship }]
            : []
      );
      const existing = previous[0]?.relationship;
      if (
       (existing ? hierarchyNodeIds(profile, existing).parentId : null) ===
         command.parentId
      ) {
       return undefined;
      }
      const routes: RouteSnapshotsByRelationship = Object.fromEntries(
       previous.map(({ relationship }) => [
         relationship.id,
         relationshipRouteState(document, relationship.id)
       ])
      );
      const visualOverrides: VisualOverrideSnapshotsByRelationship =
       Object.fromEntries(
         previous.map(({ relationship }) => [
           relationship.id,
           relationshipVisualOverrideState(document, relationship.id)
         ])
       );
      for (const { relationship } of previous) {
       clearRelationshipRoutes(document, relationship.id);
       clearRelationshipVisualOverrides(document, relationship.id);
      }
      document.relationships = document.relationships.filter(
        (relationship) =>
          !(
            relationship.type === hierarchyType &&
            hierarchyNodeIds(profile, relationship).childId === command.nodeId
          )
      );
      if (command.parentId) {
        const relationship: GraphRelationship = existing
          ? {
              ...structuredClone(existing),
              ...hierarchyRelationshipEndpoints(
                profile,
                command.parentId,
                command.nodeId
              )
            }
          : {
              id:
                command.relationshipId ??
                `rel_${command.parentId}_${command.nodeId}`,
              type: hierarchyType,
              ...hierarchyRelationshipEndpoints(
                profile,
                command.parentId,
                command.nodeId
              ),
              properties: {}
            };
        const index = previous[0]?.index ?? document.relationships.length;
        document.relationships.splice(
          Math.min(index, document.relationships.length),
          0,
          relationship
        );
        if (existing) {
          restoreRelationshipVisualOverrides(
            document,
            relationship.id,
            visualOverrides[relationship.id] ?? {}
          );
        }
      }
      return {
        type: "restore-hierarchy",
        nodeId: command.nodeId,
        relationships: previous,
        routes,
        visualOverrides
      };
    }
    case "restore-hierarchy": {
      const profile = getProfile(document);
      const hierarchyType = profile.hierarchyRelationship;
      if (!hierarchyType) {
        throw new Error(
          `${document.document.profile} does not define a hierarchy`
        );
      }
      const previous = document.relationships.flatMap(
        (relationship, index) =>
          relationship.type === hierarchyType &&
          hierarchyNodeIds(profile, relationship).childId === command.nodeId
            ? [{ index, relationship }]
            : []
      );
      const routes: RouteSnapshotsByRelationship = Object.fromEntries(
        previous.map(({ relationship }) => [
          relationship.id,
          relationshipRouteState(document, relationship.id)
        ])
      );
      const visualOverrides: VisualOverrideSnapshotsByRelationship =
        Object.fromEntries(
          previous.map(({ relationship }) => [
            relationship.id,
            relationshipVisualOverrideState(document, relationship.id)
          ])
        );
      for (const { relationship } of previous) {
        clearRelationshipRoutes(document, relationship.id);
        clearRelationshipVisualOverrides(document, relationship.id);
      }
      document.relationships = document.relationships.filter(
        (relationship) =>
          !(
            relationship.type === hierarchyType &&
            hierarchyNodeIds(profile, relationship).childId === command.nodeId
          )
      );
      for (const entry of [...command.relationships].sort(
        (left, right) => left.index - right.index
      )) {
        document.relationships.splice(
          entry.index,
          0,
          structuredClone(entry.relationship)
        );
        restoreRelationshipRoutes(
          document,
          entry.relationship.id,
          command.routes[entry.relationship.id] ?? {}
        );
        restoreRelationshipVisualOverrides(
          document,
          entry.relationship.id,
          command.visualOverrides[entry.relationship.id] ?? {}
        );
      }
      return {
        type: "restore-hierarchy",
        nodeId: command.nodeId,
        relationships: previous,
        routes,
        visualOverrides
      };
    }
  }
}

function graphValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => graphValuesEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        graphValuesEqual(leftRecord[key], rightRecord[key])
    )
  );
}

export function applyBatch(
  current: GraphDocument,
  commands: readonly GraphCommand[]
): BatchResult {
  const document = structuredClone(current);
  const inverse: GraphCommand[] = [];
  for (const command of commands) {
    const appliedInverse = applyCommand(document, command);
    if (appliedInverse) inverse.unshift(appliedInverse);
  }

  const validation = validateDocument(document);
  if (!validation.valid) {
    const details = validation.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    throw new Error(`Command batch rejected:\n${details}`);
  }

  if (graphValuesEqual(document, current)) {
    return { document: current, inverse: [] };
  }
  return { document, inverse };
}
