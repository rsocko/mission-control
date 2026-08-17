import { randomUUID } from 'crypto';
import type { TaskItem } from '@/types';
import type { ExternalIdentityObservation } from '@/lib/external-identities/types';
import { connectorLogger } from '@/lib/logger';
import { assertUniqueGitHubProjectIdentities } from '@/lib/sync/github-project-association-identity';
import type { GitHubClient, GitHubProjectV2, GitHubProjectV2Item } from './github-client';
import { issueEvidenceFromGraphQL } from './identity';

/** Data returned from project sync to create hub projects and link tasks */
export interface GitHubProjectAssociation {
  project: GitHubProjectV2;
  membershipState: 'complete' | 'partial' | 'inaccessible';
  /** Task sourceIds that belong to this project */
  taskSourceIds: string[];
  taskIdentityEvidence: Array<{
    sourceId: string;
    evidence: import('@/lib/external-identities/types').ExternalIdentityEvidence;
  }>;
}

export interface GitHubProjectTaskContext {
  metadataBySourceId: Map<string, Array<{
    projectNumber: number;
    projectTitle: string;
    sourceId: string;
    fields: Record<string, string>;
  }>>;
  draftTasks: TaskItem[];
}

/** Everything the projects sync service needs from the owning connector instance. */
export interface GitHubProjectsSyncContext {
  client: GitHubClient;
  repos: string[];
  connectorId: string;
  connectorType: string;
  repositoryEvidenceBySourceId: ReadonlyMap<string, ExternalIdentityObservation>;
}

/**
 * Discovers GitHub Projects V2 for a connector's configured repos/viewer,
 * fetches their item membership, and maps items to hub-project associations
 * and draft-issue tasks.
 *
 * Owns the per-fetch state (`lastAssociations`, `projectOwnerMap`) that used
 * to live directly on `GitHubIssuesConnector`, so it can be constructed and
 * exercised independently of issue CRUD or notification concerns.
 */
export class GitHubProjectsSyncService {
  /** Tracks project ownership so item queries use the correct owner type/login */
  private projectOwnerMap = new Map<string, { type: 'user' | 'organization'; login: string }>();

  /** Associations discovered by the most recent fetchProjectTaskContext() call */
  private lastAssociations: GitHubProjectAssociation[] = [];

  getLastAssociations(): GitHubProjectAssociation[] {
    return this.lastAssociations;
  }

  async fetchProjectTaskContext(context: GitHubProjectsSyncContext): Promise<GitHubProjectTaskContext> {
    const projects = await this.fetchProjectsV2(context);
    this.lastAssociations = [];
    const metadataBySourceId: GitHubProjectTaskContext['metadataBySourceId'] = new Map();
    const draftTasks: TaskItem[] = [];

    for (const project of projects) {
      const membership = await this.fetchProjectItemsForProject(context, project);
      const association: GitHubProjectAssociation = {
        project,
        membershipState: membership.state,
        taskSourceIds: [],
        taskIdentityEvidence: [],
      };

      for (const item of membership.items) {
        if (!item.content) {
          association.membershipState = 'partial';
          continue;
        }

        // Extract project field values (Status, Priority, etc.)
        const projectFields = this.extractProjectFields(item);

        if (item.content.__typename === 'Issue') {
          if (
            !item.content.repository
            || !item.content.id
            || !item.content.number
          ) {
            association.membershipState = 'partial';
            continue;
          }
          const repo = item.content.repository.nameWithOwner;
          const issueSourceId = `${repo}:${item.content.number}`;

          const isConfiguredRepo = context.repos.some(
            (r: string) => r.toLowerCase() === repo.toLowerCase()
          );
          if (isConfiguredRepo) {
            const projectMetadata = metadataBySourceId.get(issueSourceId) || [];
            projectMetadata.push({
              projectNumber: project.number,
              projectTitle: project.title,
              sourceId: `project:${project.number}`,
              fields: projectFields,
            });
            metadataBySourceId.set(issueSourceId, projectMetadata);
            association.taskSourceIds.push(issueSourceId);
            const repositoryEvidence = context.repositoryEvidenceBySourceId.get(repo);
            if (repositoryEvidence) {
              association.taskIdentityEvidence.push({
                sourceId: issueSourceId,
                evidence: issueEvidenceFromGraphQL(
                  item.content.id,
                  item.content.number,
                  item.content.url,
                  repositoryEvidence,
                  context.client.origin,
                  new Date().toISOString(),
                ),
              });
            }
          }
        } else if (item.content.__typename === 'DraftIssue') {
          const task = this.draftIssueToTask(context, item, project, projectFields);
          draftTasks.push(task);
          association.taskSourceIds.push(task.sourceId);
        }
      }

      this.lastAssociations.push(association);
    }

    return { metadataBySourceId, draftTasks };
  }

  private async fetchProjectsV2(context: GitHubProjectsSyncContext): Promise<GitHubProjectV2[]> {
    const { client, repos } = context;
    const projects: GitHubProjectV2[] = [];
    const seenIds = new Set<string>();

    const addProjects = (nodes: GitHubProjectV2[], ownerType: 'user' | 'organization', ownerLogin: string) => {
      for (const p of nodes) {
        if (p.closed || seenIds.has(p.id)) continue;
        seenIds.add(p.id);
        projects.push(p);
        this.projectOwnerMap.set(p.id, { type: ownerType, login: ownerLogin });
      }
    };

    // 1. Fetch projects owned by the authenticated user (viewer)
    const viewerQuery = `
      query($cursor: String) {
        viewer {
          login
          projectsV2(first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              number
              title
              shortDescription
              url
              closed
              items { totalCount }
            }
          }
        }
      }
    `;

    try {
      let hasNextPage = true;
      const variables: Record<string, unknown> = {};
      let viewerLogin = '';
      while (hasNextPage) {
        const data = await client.graphqlFetchAny(viewerQuery, variables);
        if (data.errors?.length) {
          connectorLogger.warn({ errors: data.errors }, 'GitHub Projects V2 viewer query errors');
          break;
        }
        viewerLogin = viewerLogin || data.data?.viewer?.login || '';
        const connection = data.data?.viewer?.projectsV2;
        const nodes: GitHubProjectV2[] = connection?.nodes || [];
        addProjects(nodes, 'user', viewerLogin);
        hasNextPage = connection?.pageInfo?.hasNextPage || false;
        if (hasNextPage && connection?.pageInfo?.endCursor) {
          variables.cursor = connection.pageInfo.endCursor;
        }
      }
    } catch (err) {
      connectorLogger.warn({ err }, 'Failed to fetch viewer GitHub Projects V2');
    }

    // 2. Fetch org-level and repo-level projects from configured repos
    const orgsQueried = new Set<string>();
    for (const repo of repos) {
      const [owner, name] = repo.split('/');

      // Repo-level projects
      try {
        const repoProjectsQuery = `
          query($owner: String!, $name: String!, $cursor: String) {
            repository(owner: $owner, name: $name) {
              projectsV2(first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  number
                  title
                  shortDescription
                  url
                  closed
                  items { totalCount }
                  owner { __typename ... on Organization { login } ... on User { login } }
                }
              }
            }
          }
        `;
        let hasNextPage = true;
        const vars: Record<string, unknown> = { owner, name };
        while (hasNextPage) {
          const data = await client.graphqlFetchAny(repoProjectsQuery, vars);
          if (data.errors?.length) {
            connectorLogger.warn({ repo, errors: data.errors }, 'GitHub Projects V2 repo query errors');
            break;
          }
          const connection = data.data?.repository?.projectsV2;
          const nodes = (connection?.nodes || []) as Array<GitHubProjectV2 & { owner?: { __typename: string; login: string } }>;
          for (const node of nodes) {
            const ownerType = node.owner?.__typename === 'Organization' ? 'organization' : 'user';
            const ownerLogin = node.owner?.login || owner;
            addProjects([node], ownerType as 'user' | 'organization', ownerLogin);
          }
          hasNextPage = connection?.pageInfo?.hasNextPage || false;
          if (hasNextPage && connection?.pageInfo?.endCursor) {
            vars.cursor = connection.pageInfo.endCursor;
          }
        }
      } catch (err) {
        connectorLogger.warn({ repo, err }, 'Failed to fetch repo-level Projects V2');
      }

      // Org-level projects (query each org only once)
      if (!orgsQueried.has(owner)) {
        orgsQueried.add(owner);
        try {
          const orgProjectsQuery = `
            query($login: String!, $cursor: String) {
              organization(login: $login) {
                projectsV2(first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id
                    number
                    title
                    shortDescription
                    url
                    closed
                    items { totalCount }
                  }
                }
              }
            }
          `;
          let hasNextPage = true;
          const vars: Record<string, unknown> = { login: owner };
          while (hasNextPage) {
            const data = await client.graphqlFetchAny(orgProjectsQuery, vars);
            if (data.errors?.length) {
              // Not an org — that's fine, skip silently
              break;
            }
            const connection = data.data?.organization?.projectsV2;
            if (!connection) break; // owner is a user, not an org
            const nodes: GitHubProjectV2[] = connection.nodes || [];
            addProjects(nodes, 'organization', owner);
            hasNextPage = connection.pageInfo?.hasNextPage || false;
            if (hasNextPage && connection.pageInfo?.endCursor) {
              vars.cursor = connection.pageInfo.endCursor;
            }
          }
        } catch {
          // Owner is not an org or token lacks access — skip silently
        }
      }
    }

    connectorLogger.info({ count: projects.length, titles: projects.map(p => p.title) }, 'Discovered GitHub Projects V2');
    assertUniqueGitHubProjectIdentities(projects.map((project) => ({ project })));
    return projects;
  }

  private async fetchProjectItemsForProject(
    context: GitHubProjectsSyncContext,
    project: Pick<GitHubProjectV2, 'id' | 'number'>,
  ): Promise<{
    items: GitHubProjectV2Item[];
    state: GitHubProjectAssociation['membershipState'];
  }> {
    const { client } = context;
    const items: GitHubProjectV2Item[] = [];
    const projectNumber = project.number;

    const ownerInfo = this.projectOwnerMap.get(project.id);

    // Use organization query for org-owned projects, user query otherwise
    const ownerField = ownerInfo?.type === 'organization' ? 'organization' : 'user';
    const query = `
      query($login: String!, $projectNumber: Int!, $cursor: String) {
        ${ownerField}(login: $login) {
          projectV2(number: $projectNumber) {
            items(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                fieldValues(first: 10) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field { ... on ProjectV2SingleSelectField { name } }
                      name
                    }
                    ... on ProjectV2ItemFieldTextValue {
                      field { ... on ProjectV2Field { name } }
                      text
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      field { ... on ProjectV2Field { name } }
                      date
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    title
                    body
                    state
                    createdAt
                    updatedAt
                    closedAt
                    url
                    labels(first: 20) { nodes { name color } }
                    assignees(first: 5) { nodes { login } }
                    repository { nameWithOwner }
                  }
                  ... on DraftIssue {
                    title
                    body
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      let login: string;
      if (ownerInfo) {
        login = ownerInfo.login;
      } else {
        // Fallback: get authenticated user login
        const userRes = await client.restFetch('/user');
        if (!userRes.ok) return { items, state: 'inaccessible' };
        const userData = await userRes.json();
        login = userData.login;
      }

      let hasNextPage = true;
      const variables: Record<string, unknown> = { login, projectNumber };
      while (hasNextPage) {
        const data = await client.graphqlFetchAny(query, variables);
        if (data.errors?.length) {
          connectorLogger.warn({ projectNumber, errors: data.errors }, 'GitHub Project items query errors');
          return { items, state: items.length > 0 ? 'partial' : 'inaccessible' };
        }
        const connection = data.data?.[ownerField]?.projectV2?.items;
        if (!connection) return { items, state: 'inaccessible' };
        const nodes: GitHubProjectV2Item[] = connection?.nodes || [];
        items.push(...nodes);
        hasNextPage = connection?.pageInfo?.hasNextPage || false;
        if (hasNextPage) {
          if (!connection.pageInfo?.endCursor) return { items, state: 'partial' };
          variables.cursor = connection.pageInfo.endCursor;
        }
      }
    } catch (err) {
      connectorLogger.warn({ projectNumber, err }, 'Failed to fetch items for GitHub Project');
      return { items, state: items.length > 0 ? 'partial' : 'inaccessible' };
    }

    return { items, state: 'complete' };
  }

  private extractProjectFields(item: GitHubProjectV2Item): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const fv of item.fieldValues.nodes) {
      const fieldName = fv.field?.name;
      if (!fieldName) continue;
      if (fv.name) fields[fieldName] = fv.name;
      else if (fv.text) fields[fieldName] = fv.text;
      else if (fv.date) fields[fieldName] = fv.date;
    }
    return fields;
  }

  /**
   * @remarks Not currently invoked by `fetchProjectTaskContext` (project-backed
   * Issue items are merged onto the matching repo-fetched task via
   * `metadataBySourceId` instead of being converted directly). Retained
   * as-is from the pre-extraction implementation for API compatibility.
   */
  private projectItemToTask(
    context: Pick<GitHubProjectsSyncContext, 'connectorType' | 'connectorId'>,
    item: GitHubProjectV2Item,
    project: GitHubProjectV2,
    repo: string,
  ): TaskItem {
    const content = item.content!;
    const labelNodes = content.labels?.nodes || [];
    const projectFields = this.extractProjectFields(item);

    return {
      id: randomUUID(),
      sourceId: `${repo}:${content.number}`,
      connectorType: context.connectorType,
      connectorInstanceId: context.connectorId,
      title: content.title || 'Untitled',
      description: content.body || undefined,
      status: content.state === 'CLOSED' ? 'done' : 'todo',
      priority: 'none',
      createdAt: content.createdAt || new Date().toISOString(),
      updatedAt: content.updatedAt || new Date().toISOString(),
      completedAt: content.closedAt || undefined,
      parentId: undefined,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: repo,
      sourceListName: repo,
      hubProjectIds: [],
      tags: labelNodes.map((label: { name: string; color: string }) => ({
        id: randomUUID(),
        name: label.name,
        slug: label.name.toLowerCase().replace(/\s+/g, '-'),
        type: 'source' as const,
        source: context.connectorType,
        color: `#${label.color}`,
        confirmed: true,
        createdAt: new Date().toISOString(),
      })),
      assignee: content.assignees?.nodes?.[0]?.login || undefined,
      metadata: {
        issueNumber: content.number,
        nodeId: content.id,
        url: content.url,
        githubProjects: [{
          projectNumber: project.number,
          projectTitle: project.title,
          sourceId: `project:${project.number}`,
          fields: projectFields,
        }],
      },
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
    };
  }

  private draftIssueToTask(
    context: GitHubProjectsSyncContext,
    item: GitHubProjectV2Item,
    project: GitHubProjectV2,
    projectFields: Record<string, string>,
  ): TaskItem {
    const content = item.content!;
    return {
      id: randomUUID(),
      sourceId: `project:${project.number}:draft:${item.id}`,
      connectorType: context.connectorType,
      connectorInstanceId: context.connectorId,
      title: content.title || 'Untitled draft',
      description: content.body || undefined,
      status: 'todo',
      priority: 'none',
      createdAt: content.createdAt || new Date().toISOString(),
      updatedAt: content.updatedAt || new Date().toISOString(),
      parentId: undefined,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      // Draft issues have no repo — they live only in the project.
      // No sourceListId; they're accessible via their hub project association.
      sourceListId: undefined,
      sourceListName: `${project.title} (draft)`,
      hubProjectIds: [],
      tags: [],
      metadata: {
        draftIssueId: item.id,
        isDraft: true,
        githubProjects: [{
          projectNumber: project.number,
          projectTitle: project.title,
          sourceId: `project:${project.number}`,
          fields: projectFields,
        }],
      },
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
    };
  }
}
