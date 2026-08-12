/**
 * Transforms GitHub issues (GraphQL + REST) into internal TaskItem format.
 */

import type { TaskItem } from '@/types';
import { randomUUID } from 'crypto';
import { extractMicroStatusFromTags, isMicroStatusTag } from '@/lib/micro-status';
import { isPriorityLabel, isEffortLabel } from './label-handler';
import type { GraphQLIssue, GitHubRestIssue } from './github-client';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';

/** Returns true for labels whose purpose is represented by a structured field (priority, effort, micro-status). */
function isSyntheticTag(labelName: string): boolean {
  return isMicroStatusTag(labelName) || isPriorityLabel(labelName) || isEffortLabel(labelName);
}

const CONNECTOR_TYPE = 'github-issues';

export interface GitHubParentMetadata {
  sourceId: string;
  repository: string;
  issueNumber: number;
  nodeId: string;
  title: string;
  url: string;
}

/** Maps a GitHub issue stateReason string to an internal statusReason value */
function mapStateReason(stateReason: string | null | undefined): 'completed' | 'not_planned' | 'duplicate' | undefined {
  switch (stateReason?.toLowerCase()) {
    case 'completed': return 'completed';
    case 'not_planned': return 'not_planned';
    case 'duplicate': return 'duplicate';
    default: return undefined;
  }
}

export function mapGraphQLIssueToTask(
  issue: GraphQLIssue,
  repo: string,
  connectorInstanceId: string,
  externalIdentity?: ExternalIdentityEvidence,
  githubParentIdentity?: ExternalIdentityEvidence,
): TaskItem {
  const labelNodes = issue.labels?.nodes || [];
  const labelNames = labelNodes.map((l: { name: string }) => l.name);
  const microStatus = extractMicroStatusFromTags(labelNames);

  const githubParent: GitHubParentMetadata | null = issue.parent
    ? {
        sourceId: `${issue.parent.repository.nameWithOwner}:${issue.parent.number}`,
        repository: issue.parent.repository.nameWithOwner,
        issueNumber: issue.parent.number,
        nodeId: issue.parent.id,
        title: issue.parent.title,
        url: issue.parent.url,
      }
    : null;

  return {
    id: randomUUID(),
    sourceId: `${repo}:${issue.number}`,
    connectorType: CONNECTOR_TYPE,
    connectorInstanceId,
    title: issue.title,
    description: issue.body || undefined,
    status: issue.state === 'CLOSED' ? 'done' : 'todo',
    microStatus: microStatus || undefined,
    statusReason: mapStateReason(issue.stateReason),
    priority: inferPriority(labelNodes),
    effort: inferEffort(labelNodes),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    completedAt: issue.closedAt || undefined,
    parentId: undefined,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: repo,
    sourceListName: repo,
    hubProjectIds: [],
    tags: labelNodes
      .filter((label: { name: string }) => !isSyntheticTag(label.name))
      .map((label: { name: string; color: string }) => ({
        id: randomUUID(),
        name: label.name,
        slug: label.name.toLowerCase().replace(/\s+/g, '-'),
        type: 'source' as const,
        source: CONNECTOR_TYPE,
        color: `#${label.color}`,
        confirmed: true,
        createdAt: new Date().toISOString(),
      })),
    assignee: issue.assignees?.nodes?.[0]?.login || undefined,
    metadata: {
      issueNumber: issue.number,
      nodeId: issue.id,
      url: issue.url,
      milestone: issue.milestone?.title,
      parentNumber: issue.parent?.number,
      githubParent,
    },
    externalIdentity,
    githubParentIdentity,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  };
}

export function mapRestIssueToTask(
  issue: GitHubRestIssue,
  repo: string,
  connectorInstanceId: string,
  externalIdentity?: ExternalIdentityEvidence,
): TaskItem {
  const labelNames = (issue.labels || []).map(l => typeof l === 'string' ? l : l.name);
  const microStatus = extractMicroStatusFromTags(labelNames);

  return {
    id: randomUUID(),
    sourceId: `${repo}:${issue.number}`,
    connectorType: CONNECTOR_TYPE,
    connectorInstanceId,
    title: issue.title,
    description: issue.body || undefined,
    status: issue.state === 'closed' ? 'done' : 'todo',
    microStatus: microStatus || undefined,
    statusReason: mapStateReason(issue.state_reason),
    priority: inferPriorityFromLabels(issue.labels || []),
    effort: inferEffortFromLabels(issue.labels || []),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    completedAt: issue.closed_at || undefined,
    parentId: undefined,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: repo,
    sourceListName: repo,
    hubProjectIds: [],
    tags: (issue.labels || [])
      .filter((label) => !isSyntheticTag(typeof label === 'string' ? label : label.name))
      .map((label) => ({
        id: randomUUID(),
        name: typeof label === 'string' ? label : label.name,
        slug: (typeof label === 'string' ? label : label.name).toLowerCase().replace(/\s+/g, '-'),
        type: 'source' as const,
        source: CONNECTOR_TYPE,
        color: typeof label === 'string' ? undefined : `#${label.color}`,
        confirmed: true,
        createdAt: new Date().toISOString(),
      })),
    assignee: issue.assignee?.login || undefined,
    metadata: {
      issueNumber: issue.number,
      ...(issue.node_id ? { nodeId: issue.node_id } : {}),
      url: issue.html_url,
    },
    externalIdentity,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  };
}

export function parseMarkdownTaskList(
  body: string,
  parentId: string,
  connectorInstanceId: string,
  repo?: string,
  parentSourceId?: string,
  parentCreatedAt?: string,
): TaskItem[] {
  const taskListRegex = /^[\s]*-\s+\[([ xX])\]\s+(.+)$/gm;
  const items: TaskItem[] = [];
  let match;

  while ((match = taskListRegex.exec(body)) !== null) {
    const isChecked = match[1].toLowerCase() === 'x';
    const title = match[2].trim();

    items.push({
      id: randomUUID(),
      sourceId: `checklist:${parentSourceId || parentId}:${items.length}`,
      connectorType: CONNECTOR_TYPE,
      connectorInstanceId,
      title,
      status: isChecked ? 'done' : 'todo',
      priority: 'none',
      createdAt: parentCreatedAt || new Date().toISOString(),
      updatedAt: parentCreatedAt || new Date().toISOString(),
      parentId,
      childIds: [],
      depth: 1,
      isChecklistItem: true,
      sourceListId: repo,
      sourceListName: repo,
      hubProjectIds: [],
      tags: [],
      metadata: { checklistIndex: items.length },
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
    });
  }

  return items;
}

export function parseSourceId(sourceId: string): { repo: string; issueNumber: number } {
  const lastColon = sourceId.lastIndexOf(':');
  return {
    repo: sourceId.substring(0, lastColon),
    issueNumber: parseInt(sourceId.substring(lastColon + 1), 10),
  };
}

export function isNativeGitHubIssueSourceId(sourceId: string): boolean {
  return /^[^/:]+\/[^/:]+:\d+$/.test(sourceId);
}

function inferPriority(labels: { name: string; color: string }[]): TaskItem['priority'] {
  const names = labels.map(l => l.name.toLowerCase());
  if (names.some(n => n.includes('critical') || n.includes('p0'))) return 'critical';
  if (names.some(n => n.includes('high') || n.includes('p1') || n.includes('urgent'))) return 'high';
  if (names.some(n => n.includes('medium') || n.includes('p2'))) return 'medium';
  if (names.some(n => n.includes('low') || n.includes('p3'))) return 'low';
  if (names.some(n => n.includes('bug'))) return 'high';
  return 'none';
}

function inferPriorityFromLabels(labels: Array<string | { name: string; color: string }>): TaskItem['priority'] {
  const names = labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase());
  if (names.some(n => n.includes('critical') || n.includes('p0'))) return 'critical';
  if (names.some(n => n.includes('high') || n.includes('p1') || n.includes('urgent'))) return 'high';
  if (names.some(n => n.includes('medium') || n.includes('p2'))) return 'medium';
  if (names.some(n => n.includes('low') || n.includes('p3'))) return 'low';
  if (names.some(n => n.includes('bug'))) return 'high';
  return 'none';
}

/**
 * Infer effort level from GitHub labels.
 * Supports patterns: "effort:xs", "effort-s", "size/m", "t-shirt:l", "XL", "effort:1" etc.
 */
function inferEffort(labels: { name: string }[]): number | undefined {
  const names = labels.map(l => l.name.toLowerCase());
  return matchEffortFromNames(names);
}

function inferEffortFromLabels(labels: Array<string | { name: string }>): number | undefined {
  const names = labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase());
  return matchEffortFromNames(names);
}

function matchEffortFromNames(names: string[]): number | undefined {
  const effortMap: Record<string, number> = {
    xs: 1, 'extra-small': 1, 'extra small': 1, trivial: 1,
    s: 2, small: 2, easy: 2,
    m: 3, medium: 3, moderate: 3,
    l: 4, large: 4, hard: 4,
    xl: 5, 'extra-large': 5, 'extra large': 5, epic: 5,
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  };

  for (const name of names) {
    // Match patterns like "effort:xs", "effort-s", "size/m", "t-shirt:l", "effort:1"
    const match = name.match(/(?:effort|size|estimate|t-shirt)[:/\-_\s]+([\w-]+)/);
    if (match) {
      const value = effortMap[match[1]];
      if (value) return value;
    }
  }
  return undefined;
}
