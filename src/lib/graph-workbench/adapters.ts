import type {
  GraphDocument,
  GraphNode as SharedGraphNode,
  GraphRelationship,
  JsonValue,
} from '@rsocko/generic-graph-canvas-shared-workbench/core';
import { validateDocument } from '@rsocko/generic-graph-canvas-shared-workbench/core';
import {
  defineGraphHostAdapter,
  type GraphDiagnosticSink,
  type GraphHostAdapter,
  type GraphHostCapabilities,
  type GraphMutationPort,
  type GraphPersistencePort,
  type GraphProjectionSource,
} from '@rsocko/generic-graph-canvas-shared-workbench/host';
import {
  createIdeationWorkspaceDocument,
  ideationWorkspaceDocumentSchema,
  IDEATION_WORKSPACE_MAX_NODES,
} from '@/lib/graph-workspace/ideation-contract';
import type {
  IdeationNode,
  IdeationNodeKind,
  IdeationProperty,
  IdeationPropertyKey,
} from '@/lib/graph/ideation-types';
import type {
  GraphEdge,
  GraphNode,
  ProjectSubgraph,
} from '@/lib/graph/types';

const IDEATION_VIEW_ID = 'mission-control:ideation';
const PROJECT_VIEW_ID = 'mission-control:project-graph';
const IDEATION_EXTENSION = 'missionControlIdeation';
const PROJECT_NODE_EXTENSION = 'missionControlProjectNode';
const PROJECT_EDGE_EXTENSION = 'missionControlProjectEdge';

export const IDEATION_WORKBENCH_CAPABILITIES: GraphHostCapabilities = {
  supported: new Set([
    'canvas',
    'outline',
    'select',
    'arrange',
    'semantic-mutations',
    'view-mutations',
  ]),
  profileIds: ['mind-map'],
};

export const PROJECT_GRAPH_WORKBENCH_CAPABILITIES: GraphHostCapabilities = {
  supported: new Set([
    'canvas',
    'select',
    'arrange',
    'connect',
    'semantic-mutations',
  ]),
  profileIds: ['roadmap-map'],
};

interface IdeationExtension {
  kind: IdeationNodeKind;
  sortOrder: number;
  properties: Record<string, unknown>;
}

function propertyValue(value: IdeationProperty['value']): JsonValue {
  return Array.isArray(value) ? [...value] : value;
}

function ideationExtension(node: IdeationNode): Record<string, JsonValue> {
  const properties: Record<string, JsonValue> = {};
  for (const [key, property] of Object.entries(node.properties)) {
    if (!property) continue;
    properties[key] = {
      key: property.key,
      rawValue: property.rawValue,
      value: propertyValue(property.value),
    };
  }
  return {
    kind: node.kind,
    sortOrder: node.sortOrder,
    properties,
  };
}

function toSharedIdeationNode(node: IdeationNode): SharedGraphNode {
  return {
    id: node.id,
    type: 'topic',
    label: node.label,
    properties: {},
    extensions: {
      [IDEATION_EXTENSION]: ideationExtension(node),
    },
  };
}

function ideationRelationship(node: IdeationNode): GraphRelationship | null {
  if (!node.parentId) return null;
  return {
    id: `ideation:contains:${node.id}`,
    type: 'contains',
    source: node.parentId,
    target: node.id,
    properties: {},
    provenance: { kind: 'user', source: 'mission-control' },
  };
}

export function ideationNodesToGraphDocument(
  nodes: readonly IdeationNode[],
  documentId = 'mission-control:ideation:draft',
): GraphDocument {
  return {
    format: 'generic-graph-document',
    version: 1,
    document: {
      id: documentId,
      title: documentId,
      profile: 'mind-map',
    },
    nodes: nodes.map(toSharedIdeationNode),
    relationships: nodes.flatMap((node) => {
      const relationship = ideationRelationship(node);
      return relationship ? [relationship] : [];
    }),
    views: [{
      id: IDEATION_VIEW_ID,
      type: 'canvas',
      name: 'Ideation',
      placements: {},
      visibleProperties: [],
      preferredLayout: {
        strategy: 'layered-hierarchy',
        requiredCapabilities: ['hierarchy'],
      },
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseIdeationProperty(
  key: string,
  value: unknown,
): IdeationProperty | undefined {
  if (!isRecord(value) || value.key !== key || typeof value.rawValue !== 'string') {
    return undefined;
  }
  const propertyValue = value.value;
  if (
    typeof propertyValue !== 'string'
    && typeof propertyValue !== 'number'
    && !(Array.isArray(propertyValue) && propertyValue.every((item) => typeof item === 'string'))
  ) {
    return undefined;
  }
  return {
    key: key as IdeationPropertyKey,
    rawValue: value.rawValue,
    value: propertyValue,
  };
}

function readIdeationExtension(node: SharedGraphNode): IdeationExtension {
  const extension = node.extensions?.[IDEATION_EXTENSION];
  if (!isRecord(extension)) {
    throw new Error(`Shared ideation node ${node.id} is missing Mission Control metadata`);
  }
  if (
    extension.kind !== 'idea'
    && extension.kind !== 'phase'
    && extension.kind !== 'task'
  ) {
    throw new Error(`Shared ideation node ${node.id} has an invalid kind`);
  }
  if (typeof extension.sortOrder !== 'number' || !Number.isFinite(extension.sortOrder)) {
    throw new Error(`Shared ideation node ${node.id} has an invalid sibling order`);
  }
  if (!isRecord(extension.properties)) {
    throw new Error(`Shared ideation node ${node.id} has invalid properties`);
  }
  return {
    kind: extension.kind,
    sortOrder: extension.sortOrder,
    properties: extension.properties,
  };
}

export function graphDocumentToIdeationNodes(document: GraphDocument): IdeationNode[] {
  const parentByNode = new Map(
    document.relationships
      .filter((relationship) => relationship.type === 'contains')
      .map((relationship) => [relationship.target, relationship.source]),
  );
  const nodes = document.nodes.map((node): IdeationNode => {
    const extension = readIdeationExtension(node);
    const properties: IdeationNode['properties'] = {};
    for (const [key, value] of Object.entries(extension.properties)) {
      const property = parseIdeationProperty(key, value);
      if (!property) {
        throw new Error(`Shared ideation node ${node.id} has malformed property ${key}`);
      }
      properties[property.key] = property;
    }
    return {
      id: node.id,
      label: node.label,
      kind: extension.kind,
      parentId: parentByNode.get(node.id) ?? null,
      sortOrder: extension.sortOrder,
      properties,
    };
  });
  createIdeationWorkspaceDocument(nodes);
  return nodes;
}

export type IdeationNodeValidationResult =
  | { valid: true; nodes: IdeationNode[] }
  | { valid: false; message: string };

export function validateIdeationNodes(
  nodes: readonly IdeationNode[],
): IdeationNodeValidationResult {
  if (nodes.length > IDEATION_WORKSPACE_MAX_NODES) {
    return {
      valid: false,
      message: `Ideation is limited to ${IDEATION_WORKSPACE_MAX_NODES} nodes. Remove a node before adding another.`,
    };
  }
  const domain = ideationWorkspaceDocumentSchema.safeParse({
    schemaVersion: 1,
    type: 'ideation',
    nodes,
  });
  if (!domain.success) {
    return {
      valid: false,
      message: `Unable to apply that graph change: ${domain.error.issues[0]?.message ?? 'Invalid ideation document'}`,
    };
  }
  const shared = validateDocument(ideationNodesToGraphDocument(domain.data.nodes));
  if (!shared.valid) {
    return {
      valid: false,
      message: `Unable to apply that graph change: ${shared.diagnostics[0]?.message ?? 'Invalid shared graph document'}`,
    };
  }
  return { valid: true, nodes: domain.data.nodes };
}

function projectNodeExtension(node: GraphNode): Record<string, JsonValue> {
  return {
    entityId: node.entityId,
    kind: node.kind,
    status: node.status,
    ...(node.color ? { color: node.color } : {}),
    ...(node.taskCount !== undefined ? { taskCount: node.taskCount } : {}),
  };
}

function projectEdgeExtension(edge: GraphEdge): Record<string, JsonValue> {
  return {
    type: edge.type,
    provenance: edge.provenance,
    ...(edge.syncStatus ? { syncStatus: edge.syncStatus } : {}),
    ...(edge.syncAction ? { syncAction: edge.syncAction } : {}),
    ...(edge.syncError ? { syncError: edge.syncError } : {}),
  };
}

export function projectSubgraphToGraphDocument(graph: ProjectSubgraph): GraphDocument {
  const project = graph.nodes.find((node) => node.kind === 'project');
  return {
    format: 'generic-graph-document',
    version: 1,
    document: {
      id: project?.entityId ?? 'mission-control:project-graph',
      title: project?.label ?? 'Project Graph',
      profile: 'roadmap-map',
    },
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      label: node.label,
      properties: {},
      extensions: {
        [PROJECT_NODE_EXTENSION]: projectNodeExtension(node),
      },
    })),
    relationships: graph.edges.map((edge) => ({
      id: edge.id,
      type: edge.type === 'related' ? 'depends-on' : edge.type,
      source: edge.source,
      target: edge.target,
      properties: {},
      provenance: {
        kind: edge.provenance === 'explicit' ? 'user' : 'imported',
        source: 'mission-control',
      },
      extensions: {
        [PROJECT_EDGE_EXTENSION]: projectEdgeExtension(edge),
      },
    })),
    views: [{
      id: PROJECT_VIEW_ID,
      type: 'canvas',
      name: 'Project Graph',
      placements: {},
      visibleProperties: [],
      preferredLayout: {
        strategy: 'mission-control-project-hierarchy',
        requiredCapabilities: ['project-phase-task-clusters'],
      },
    }],
  };
}

const allowLocalCommands = {
  authorize: () => ({ allowed: true } as const),
};

export function createIdeationWorkbenchHost(
  persistence: GraphPersistencePort,
  diagnostics: GraphDiagnosticSink,
): GraphHostAdapter {
  return defineGraphHostAdapter({
    id: 'mission-control-ideation',
    capabilities: IDEATION_WORKBENCH_CAPABILITIES,
    policy: allowLocalCommands,
    data: { kind: 'authored-document', persistence },
    diagnostics,
  });
}

export function createProjectGraphWorkbenchHost(
  source: GraphProjectionSource,
  mutations: GraphMutationPort,
  diagnostics: GraphDiagnosticSink,
): GraphHostAdapter {
  return defineGraphHostAdapter({
    id: 'mission-control-project-graph',
    capabilities: PROJECT_GRAPH_WORKBENCH_CAPABILITIES,
    policy: allowLocalCommands,
    data: { kind: 'domain-projection', source, mutations },
    diagnostics,
  });
}
