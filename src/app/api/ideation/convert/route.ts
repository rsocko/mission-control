import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runTransaction } from '@/db';
import {
  hubProjects,
  projectPhaseItems,
  projectPhases,
  tags,
  taskDependencies,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import type {
  IdeationNode,
  IdeationPropertyKey,
} from '@/lib/graph/ideation-types';
import { extractWikiLinks } from '@/lib/ideation/property-parser';
import {
  IDEATION_PRIORITIES,
  IDEATION_STATUSES,
} from '@/lib/graph/ideation-types';
import {
  hasDuplicateDependency,
  wouldCreateBlockingCycle,
} from '@/lib/graph/project-subgraph';

const rawValueSchema = z.string().max(2000);
const stringValueSchema = z.string().max(2000);
const stringListSchema = z.array(z.string().trim().min(1).max(500)).max(100);

const propertiesSchema = z.object({
  priority: z.object({
    key: z.literal('priority'),
    rawValue: rawValueSchema,
    value: z.enum(IDEATION_PRIORITIES),
  }).optional(),
  status: z.object({
    key: z.literal('status'),
    rawValue: rawValueSchema,
    value: z.enum(IDEATION_STATUSES),
  }).optional(),
  due: z.object({
    key: z.literal('due'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
  effort: z.object({
    key: z.literal('effort'),
    rawValue: rawValueSchema,
    value: z.number().int().min(1).max(5),
  }).optional(),
  tags: z.object({
    key: z.literal('tags'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  assignee: z.object({
    key: z.literal('assignee'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
  'depends-on': z.object({
    key: z.literal('depends-on'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  related: z.object({
    key: z.literal('related'),
    rawValue: rawValueSchema,
    value: stringListSchema,
  }).optional(),
  notes: z.object({
    key: z.literal('notes'),
    rawValue: rawValueSchema,
    value: stringValueSchema,
  }).optional(),
}).strict().default({});

const nodeSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(500),
  kind: z.enum(['idea', 'phase', 'task']),
  parentId: z.string().min(1).max(100).nullable(),
  sortOrder: z.number().finite(),
  properties: propertiesSchema,
});

const convertSchema = z.object({
  name: z.string().trim().min(1).max(200),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  nodes: z.array(nodeSchema).min(1).max(500),
});

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function validateHierarchy(nodes: IdeationNode[]): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) return 'Ideation node IDs must be unique';
  if (nodes.filter((node) => node.parentId === null).length !== 1) {
    return 'Ideation must contain exactly one root node';
  }
  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      return `Parent node for "${node.label}" does not exist`;
    }
    const visited = new Set([node.id]);
    let current = node;
    while (current.parentId) {
      if (visited.has(current.parentId)) return 'Ideation hierarchy cannot contain cycles';
      visited.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
  }
  return null;
}

function propertyValue<T extends string | number | string[]>(
  node: IdeationNode,
  key: IdeationPropertyKey,
): T | undefined {
  return node.properties[key]?.value as T | undefined;
}

export async function POST(request: Request) {
  try {
    const parsed = convertSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.validation(parsed.error.issues[0]?.message ?? 'Invalid ideation draft');
    }

    const hierarchyError = validateHierarchy(parsed.data.nodes);
    if (hierarchyError) return ApiErrors.validation(hierarchyError);

    const projectId = `proj-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const nodes = parsed.data.nodes as IdeationNode[];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const phaseIdByNode = new Map<string, string>();
    const taskIdByNode = new Map<string, string>();
    const taskNodeByLabel = new Map<string, IdeationNode>();
    const taskNodesByLabel = new Map<string, IdeationNode[]>();

    for (const node of nodes) {
      if (node.kind === 'phase') phaseIdByNode.set(node.id, `phase-${crypto.randomUUID()}`);
      if (node.kind === 'task') {
        taskIdByNode.set(node.id, `task-${crypto.randomUUID()}`);
        const normalizedLabel = node.label.toLowerCase();
        const matchingNodes = [...(taskNodesByLabel.get(normalizedLabel) ?? []), node];
        taskNodesByLabel.set(normalizedLabel, matchingNodes);
        if (matchingNodes.length === 1) taskNodeByLabel.set(normalizedLabel, node);
      }
    }

    const relationshipLabels = (
      node: IdeationNode,
      type: 'blocks' | 'related',
    ): string[] => {
      if (type === 'blocks') return propertyValue<string[]>(node, 'depends-on') ?? [];
      const explicit = propertyValue<string[]>(node, 'related') ?? [];
      const notes = propertyValue<string>(node, 'notes') ?? '';
      return [...new Set([
        ...explicit,
        ...extractWikiLinks(node.label),
        ...extractWikiLinks(notes),
      ])];
    };

    for (const node of nodes.filter((candidate) => candidate.kind === 'task')) {
      for (const type of ['blocks', 'related'] as const) {
        for (const label of relationshipLabels(node, type)) {
          const matches = taskNodesByLabel.get(label.toLowerCase()) ?? [];
          if (matches.length > 1) {
            return ApiErrors.validation(`Relationship "${label}" is ambiguous because multiple tasks use that title`);
          }
          if (matches.length === 0) {
            return ApiErrors.validation(`Relationship target "${label}" does not exist in this ideation draft`);
          }
          if (matches[0].id === node.id) {
            return ApiErrors.validation(`Task "${node.label}" cannot link to itself`);
          }
        }
      }
    }

    // Reuse the canonical validators, but insert with the new tasks so conversion
    // remains one transaction instead of calling the existing-task mutator.
    const relationshipValues: Array<{
        id: string;
        taskId: string;
        dependsOnTaskId: string;
        type: 'blocks' | 'related';
        connectorInstanceId: null;
        syncStatus: 'local';
        syncAction: null;
        syncError: null;
        lastSyncedAt: null;
        createdAt: string;
    }> = [];
    for (const node of nodes.filter((candidate) => candidate.kind === 'task')) {
      const currentTaskId = taskIdByNode.get(node.id)!;
      for (const type of ['blocks', 'related'] as const) {
        for (const label of relationshipLabels(node, type)) {
          const relationshipNode = taskNodeByLabel.get(label.toLowerCase())!;
          const relationshipTaskId = taskIdByNode.get(relationshipNode.id)!;
          const [sourceTaskId, targetTaskId] = type === 'blocks'
            ? [relationshipTaskId, currentTaskId]
            : [currentTaskId, relationshipTaskId].sort();

          if (hasDuplicateDependency(
            relationshipValues,
            sourceTaskId,
            targetTaskId,
            type,
          )) {
            return ApiErrors.validation(`Relationship between "${node.label}" and "${label}" is duplicated`);
          }
          if (
            type === 'blocks'
            && wouldCreateBlockingCycle(
              relationshipValues,
              sourceTaskId,
              targetTaskId,
            )
          ) {
            return ApiErrors.validation(`Dependency for "${node.label}" would create a cycle`);
          }

          relationshipValues.push({
            id: crypto.randomUUID(),
            taskId: targetTaskId,
            dependsOnTaskId: sourceTaskId,
            type,
            connectorInstanceId: null,
            syncStatus: 'local',
            syncAction: null,
            syncError: null,
            lastSyncedAt: null,
            createdAt: now,
          });
        }
      }
    }

    const nearestAncestor = (node: IdeationNode, kind: IdeationNode['kind']) => {
      let current = node;
      while (current.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) return null;
        if (parent.kind === kind) return parent;
        current = parent;
      }
      return null;
    };
    const taskDepth = (node: IdeationNode) => {
      let depth = 0;
      let current = node;
      while (current.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) break;
        if (parent.kind === 'task') depth += 1;
        current = parent;
      }
      return depth;
    };

    runTransaction((tx) => {
      tx.insert(hubProjects).values({
        id: projectId,
        name: parsed.data.name,
        description: 'Created from the Graph ideation canvas.',
        color: parsed.data.color,
        icon: 'Lightbulb',
        iconColor: parsed.data.color,
        sourceBindings: [],
        autoIncludeRules: [],
        kanbanColumns: [],
        defaultView: 'list',
        metadata: { source: 'ideation' },
        createdAt: now,
        updatedAt: now,
      }).run();

      const phaseValues = nodes
        .filter((node) => node.kind === 'phase')
        .map((node) => ({
          id: phaseIdByNode.get(node.id)!,
          projectId,
          name: node.label,
          description: propertyValue<string>(node, 'notes') ?? null,
          status: 'pending',
          color: parsed.data.color,
          sortOrder: node.sortOrder,
          createdAt: now,
          updatedAt: now,
        }));
      if (phaseValues.length) tx.insert(projectPhases).values(phaseValues).run();

      const taskValues = nodes
        .filter((node) => node.kind === 'task')
        .map((node) => {
          const taskId = taskIdByNode.get(node.id)!;
          const parentTask = nearestAncestor(node, 'task');
          return {
            id: taskId,
            sourceId: taskId,
            connectorType: 'local',
            connectorInstanceId: 'local',
            title: node.label,
            description: propertyValue<string>(node, 'notes') ?? null,
            status: propertyValue<string>(node, 'status') ?? 'todo',
            priority: propertyValue<string>(node, 'priority') ?? 'none',
            assignee: propertyValue<string>(node, 'assignee') ?? null,
            dueDate: propertyValue<string>(node, 'due') ?? null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            parentId: parentTask ? taskIdByNode.get(parentTask.id) ?? null : null,
            depth: taskDepth(node),
            isChecklistItem: false,
            metadata: { ideationNodeId: node.id },
            syncStatus: 'synced',
            lastSyncedAt: now,
            pushRetryCount: 0,
            effort: propertyValue<number>(node, 'effort') ?? null,
            isBulkImport: false,
          };
        });
      if (taskValues.length) tx.insert(tasks).values(taskValues).run();

      const memberships = [...taskIdByNode.values()].map((taskId) => ({ taskId, projectId }));
      if (memberships.length) tx.insert(taskProjects).values(memberships).run();

      const phaseItems = nodes
        .filter((node) => node.kind === 'task')
        .flatMap((node) => {
          const phase = nearestAncestor(node, 'phase');
          if (!phase) return [];
          return [{
            id: crypto.randomUUID(),
            phaseId: phaseIdByNode.get(phase.id)!,
            taskId: taskIdByNode.get(node.id)!,
            sortOrder: node.sortOrder,
            createdAt: now,
          }];
        });
      if (phaseItems.length) tx.insert(projectPhaseItems).values(phaseItems).run();

      const existingTags = tx.select().from(tags).all();
      const tagBySlug = new Map(existingTags.map((tag) => [tag.slug, tag]));
      const tagLinks: Array<{ taskId: string; tagId: string }> = [];
      for (const node of nodes.filter((candidate) => candidate.kind === 'task')) {
        for (const tagName of propertyValue<string[]>(node, 'tags') ?? []) {
          const slug = slugify(tagName);
          if (!slug) continue;
          let tag = tagBySlug.get(slug);
          if (!tag) {
            tag = {
              id: `tag-${crypto.randomUUID()}`,
              name: tagName,
              slug,
              type: 'hub',
              source: 'ideation',
              color: '#34d399',
              confirmed: true,
              createdAt: now,
              unifiedInto: null,
            };
            tx.insert(tags).values(tag).run();
            tagBySlug.set(slug, tag);
          }
          tagLinks.push({ taskId: taskIdByNode.get(node.id)!, tagId: tag.id });
        }
      }
      if (tagLinks.length) tx.insert(taskTags).values(tagLinks).run();

      if (relationshipValues.length) tx.insert(taskDependencies).values(relationshipValues).run();
    });

    return NextResponse.json({ projectId }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to convert ideation draft', error);
  }
}
