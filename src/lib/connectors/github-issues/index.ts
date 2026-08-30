import type {
  IConnector,
  ConnectorFactory,
  TransferIdentityRefresh,
} from '../index';
import { type NotificationWritebackAction } from '../notification-writeback-contract';
import type {
 TaskItem,
 TaskPriority,
 InboundNotification,
 ConnectorConfig,
 ConnectorCapabilities,
 FetchTaskOptions,
 SourceList,
 SourceTaskDependencyReadMode,
 SourceTaskDependencySnapshot,
} from '@/types';
import type {
  ExternalIdentityObservation,
} from '@/lib/external-identities/types';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GITHUB_ISSUES_TASK_AUTHORITY } from '../task-source-profiles';
import { mergeAsyncStreams } from '../task-page-stream';
import {
  mergeConnectorSettings,
  patchConnectorSettingsState,
} from '../shared/connector-config-store';

import { createGitHubClient } from './github-client';
import type { GitHubClient, GitHubRestIssue, GitHubRestRepository } from './github-client';
import {
  isNativeGitHubIssueSourceId,
  mapGraphQLIssueToTask,
  mapRestIssueToTask,
  parseSourceId,
} from './issue-transformer';
import {
  issueEvidenceFromGraphQL,
  issueEvidenceFromRest,
  repositoryEvidenceFromGraphQL,
  repositoryEvidenceFromRest,
} from './identity';
import { canTransferGitHubIssueSafely, transferGitHubIssueSafely } from './repoint-service';
import { syncMicroStatusLabels, syncPriorityLabels, syncEffortLabels, priorityToLabelName, effortToLabelName, ensurePriorityLabelInRepo, ensureEffortLabelInRepo, createLabelInRepo } from './label-handler';
import { isMicroStatusSyncEnabled } from '@/lib/micro-status';
import { connectorLogger } from '@/lib/logger';
import { GITHUB_NOTIFICATION_TYPES } from '@/lib/notifications/push-policy/catalogs';
import {

  GitHubWriteFenceError,
  type GitHubWriteAuthorization,
  type GitHubWriteOutcomeReadRequest,
  type GitHubWriteOutcomeReadResult,
} from '@/lib/external-identities';
import {
  GitHubProjectsSyncService,
  type GitHubProjectAssociation,
} from './projects-sync-service';
import {
  GitHubNotificationsAdapter,
  type GitHubNotificationPollState,
} from './notifications-adapter';

export type { GitHubClient } from './github-client';
export type { GraphQLIssue, GitHubRestIssue, GitHubNotification, GitHubProjectV2, GitHubProjectV2Item } from './github-client';
export type { GitHubProjectAssociation } from './projects-sync-service';
export type { GitHubNotificationPollState } from './notifications-adapter';
export { inspectGitHubRepointBackup } from './backup-verifier';
export {
  executeGitHubRepositoryRepoint,
  getGitHubRepositoryRepointStatus,
  preflightGitHubRepositoryRepoint,
  reconcileHistoricalGitHubIssueTransfer,
  rollbackGitHubRepositoryRepoint,
  verifyGitHubRepositoryRepoint,
} from './repoint-service';
export type {
  GitHubIssueTransferResult,
  GitHubHistoricalIssueResolution,
  GitHubRepositoryRepointInput,
  GitHubRepositoryRepointPreflight,
  GitHubRepositoryRepointRemote,
  GitHubRepositoryRepointStatus,
  GitHubRepointBackupProof,
} from './repoint-service';

const REPO_FETCH_CONCURRENCY = 3;
const BLOCKED_BY_PAGE_SIZE = 100;
interface GitHubWriteContext {
  authorization: GitHubWriteAuthorization;
  createdRoutes: Set<string>;
}

const githubWriteAuthorization = new AsyncLocalStorage<GitHubWriteContext>();

function writeRouteKey(owner: string, repository: string, issueNumber: number): string {
  return `${owner.toLowerCase()}/${repository.toLowerCase()}:${issueNumber}`;
}

export interface GitHubRepositoryFetchState {
  sourceId: string;
  state: 'complete' | 'partial' | 'inaccessible';
  reasonCode?: string;
}

/**
 * GitHub Issues Connector
 *
 * Uses GitHub GraphQL API for repository-qualified parent relationships.
 * Auth: Personal Access Token or GitHub App
 */

interface GitHubConfig {
  token: string;
  repos: string[];
  apiOrigin?: string;
  syncAssignedOnly?: boolean;
  syncLabels?: string[];
  fetchNotifications?: boolean;
  notificationReasons?: string[];
  participatingOnly?: boolean;
  authenticatedUser?: string;
  notificationPollState?: GitHubNotificationPollState;
}

export class GitHubIssuesConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'github-issues';
  readonly displayName = 'GitHub Issues';
  readonly icon = '🐙';
  readonly dependencySnapshotStrategy = 'task-stream' as const;
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: true,
    delete: false,
    close: true,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
    priority: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    listSelectionMode: 'required',
    tagScope: 'per-list',
    tagCreationMode: 'predefined',
    deepLinks: true,
    taskCreate: true,
    dependencyRead: true,
    dependencyWrite: true,
    ...GITHUB_ISSUES_TASK_AUTHORITY,
  };

  private config: ConnectorConfig | null = null;
  private client: GitHubClient | null = null;
  private repos: string[] = [];
  private repositoryEvidenceBySourceId = new Map<string, ExternalIdentityObservation>();
  private repositoryFetchStateBySourceId = new Map<string, GitHubRepositoryFetchState>();
  private repositoryCanonicalNameBySourceId = new Map<string, string>();
  private repositoryCanonicalNameFetchBySourceId = new Map<string, Promise<string | undefined>>();
  private dependencyReadMode: SourceTaskDependencyReadMode | null = null;
  private readonly projectsSync = new GitHubProjectsSyncService();
  private readonly notifications = new GitHubNotificationsAdapter({
    connectorType: this.type,
    getConnectorId: () => this.id,
    getClient: () => this.client!,
    persistPollState: (patch) => this.persistNotificationPollState(patch),
  });

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    const settings = config.settings as unknown as GitHubConfig;
    const token = config.credentials.token || config.credentials.pat || settings.token || '';
    this.client = createGitHubClient(token, settings.apiOrigin);
    this.repos = settings.repos || [];
    this.notifications.configure({
      fetchNotificationsEnabled: settings.fetchNotifications ?? true,
      notificationReasons: settings.notificationReasons || [],
      participatingOnly: settings.participatingOnly ?? false,
      authenticatedUser: settings.authenticatedUser || '',
      notificationPollState: settings.notificationPollState || {},
    });
    this.repositoryCanonicalNameBySourceId.clear();
    this.repositoryCanonicalNameFetchBySourceId.clear();
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.client!.restFetch('/user');
      if (res.ok) {
        const user = await res.json();
        if (this.config) {
          const currentSettings = (this.config.settings || {}) as Record<string, unknown>;
          await mergeConnectorSettings(this.config.id, currentSettings, {
            authenticatedUser: user.login,
          });
        }
        return { success: true, message: `Connected as @${user.login}` };
      }
      return { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.client = null;
    this.notifications.resetForDispose();
    this.repositoryEvidenceBySourceId.clear();
    this.repositoryFetchStateBySourceId.clear();
    this.repositoryCanonicalNameBySourceId.clear();
    this.repositoryCanonicalNameFetchBySourceId.clear();
    this.dependencyReadMode = null;
  }

  /**
   * Persists a merge-patch of the notification poll checkpoint through the
   * shared connector config store. Routed through here (rather than the
   * notifications adapter importing `@/db` directly) so the adapter stays
   * unit-testable without a real database, while the facade remains the only
   * GitHub-issues module that owns a live `ConnectorConfig`.
   */
  private async persistNotificationPollState(
    patch: Partial<GitHubNotificationPollState>,
  ): Promise<GitHubNotificationPollState> {
    if (!this.config) throw new Error('GitHub connector is not initialized');
    const { settings, state } = await patchConnectorSettingsState<GitHubNotificationPollState>(
      this.id,
      'notificationPollState',
      patch,
    );
    this.config = { ...this.config, settings };
    return state;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    const lists: SourceList[] = [];
    this.repositoryFetchStateBySourceId.clear();

    for (const repo of this.repos) {
      const [owner, name] = repo.split('/');
      const res = await this.client!.restFetch(`/repos/${owner}/${name}`);
      if (!res.ok) {
        this.repositoryFetchStateBySourceId.set(repo, {
          sourceId: repo,
          state: 'inaccessible',
          reasonCode: `repository_http_${res.status}`,
        });
        continue;
      }
      const repoData = await res.json() as GitHubRestRepository;
      this.repositoryCanonicalNameBySourceId.set(repo, repoData.full_name);
      const observedAt = new Date().toISOString();
      const externalIdentity = repositoryEvidenceFromRest(
        repoData,
        this.client!.origin,
        observedAt,
      );
      if (externalIdentity) {
        this.repositoryEvidenceBySourceId.set(repo, externalIdentity);
        this.repositoryEvidenceBySourceId.set(repoData.full_name, externalIdentity);
      }

      lists.push({
        id: `${this.id}:repo:${repo}`,
        connectorInstanceId: this.id,
        sourceId: repo,
        name: repoData.full_name,
        type: 'repo',
        taskCount: repoData.open_issues_count || 0,
        lastSyncedAt: observedAt,
        externalIdentity: externalIdentity
          ? { entity: externalIdentity }
          : undefined,
      });
      this.repositoryFetchStateBySourceId.set(repo, {
        sourceId: repo,
        state: 'complete',
      });
    }

    // GitHub Projects V2 are synced as Hub Projects, not source lists
    // (see fetchProjectAssociations / mergeProjectItems)

    return lists;
  }

  async *fetchTasks(
    since?: Date,
    options?: FetchTaskOptions,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    let generationCompleted = false;
    this.dependencyReadMode = null;
    this.repositoryCanonicalNameBySourceId.clear();
    this.repositoryCanonicalNameFetchBySourceId.clear();
    try {
      const { metadataBySourceId, draftTasks } = await this.projectsSync.fetchProjectTaskContext({
        client: this.client!,
        repos: this.repos,
        connectorId: this.id,
        connectorType: this.type,
        repositoryEvidenceBySourceId: this.repositoryEvidenceBySourceId,
      });
      const incompleteProject = this.projectsSync.getLastAssociations().find(
        (association) => association.membershipState !== 'complete',
      );

      const repoStreams = this.repos.map(repo => this.fetchRepoTaskPages(repo, since, options));
      for await (const page of mergeAsyncStreams(repoStreams, REPO_FETCH_CONCURRENCY)) {
        for (const task of page) {
          const githubProjects = metadataBySourceId.get(task.sourceId);
          if (githubProjects) {
            task.metadata.githubProjects = githubProjects;
          }
        }
        yield page;
      }

      if (incompleteProject) {
        throw new Error(
          `GitHub Project ${incompleteProject.project.number} membership observation is ${
            incompleteProject.membershipState
          }`,
        );
      }

      if (draftTasks.length > 0) {
        yield draftTasks;
      }

      if (options?.dependencyGeneration) {
        const mode = this.dependencyReadMode ?? 'graphql-bulk';
        await options.dependencyGeneration.complete(mode);
        generationCompleted = true;
      }
    } catch (error) {
      await options?.dependencyGeneration?.fail(error);
      throw error;
    } finally {
      if (options?.dependencyGeneration && !generationCompleted) {
        await options.dependencyGeneration.fail(
          new Error('GitHub task stream ended before dependency collection completed'),
        );
      }
    }
  }

  private async *fetchRepoTaskPages(
    repo: string,
    since?: Date,
    options?: FetchTaskOptions,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    let pageCount = 0;
    try {
      for await (const page of this.fetchIssuesFromRepo(repo, since, options)) {
        pageCount++;
        yield page;
      }
      this.repositoryFetchStateBySourceId.set(repo, { sourceId: repo, state: 'complete' });
    } catch (err) {
      this.repositoryFetchStateBySourceId.set(repo, {
        sourceId: repo,
        state: pageCount > 0 ? 'partial' : 'inaccessible',
        reasonCode: 'issue_fetch_failed',
      });
      connectorLogger.error({ err, repo }, 'Failed to fetch issues from repository');
      if (
        options?.dependencyGeneration
        && options.dependencyGeneration.failureMode !== 'best-effort'
      ) throw err;
    }
  }

  /**
   * Returns project-task associations discovered during the last fetchTasks() call.
   * Call this after fetchTasks() to get the data needed to create hub projects.
   */
  async fetchProjectAssociations(): Promise<GitHubProjectAssociation[]> {
    return this.projectsSync.getLastAssociations();
  }

  getIdentityObservationState(): GitHubRepositoryFetchState[] {
    return this.repos.map((repo) => this.repositoryFetchStateBySourceId.get(repo) ?? {
      sourceId: repo,
      state: 'inaccessible',
      reasonCode: 'repository_not_observed',
    });
  }

  getHierarchyRepositoryAliases(): Array<{
    sourceId: string;
    canonicalSourceId: string;
  }> {
    return [...this.repositoryCanonicalNameBySourceId].map(
      ([sourceId, canonicalSourceId]) => ({ sourceId, canonicalSourceId }),
    );
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    return this.notifications.fetchNotifications(since);
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.notifications.markNotificationRead(notificationId);
  }

  async writeNotificationAction(
    notificationId: string,
    action: NotificationWritebackAction,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.notifications.writeNotificationAction(notificationId, action, signal);
  }

  async getActiveAlertSourceIds(): Promise<null> {
    return this.notifications.getActiveAlertSourceIds();
  }

  async commitNotificationFetch(): Promise<void> {
    await this.notifications.commitNotificationFetch();
  }

  /**
   * Per-ID reconciliation for notifications that might have been resolved
   * upstream (PR merged, issue closed, review submitted).
   */
  async reconcileAlerts(activeSourceIds: string[]): Promise<import('../index').AlertReconciliation[]> {
    return this.notifications.reconcileAlerts(activeSourceIds);
  }

  async createTask(task: Partial<TaskItem>): Promise<TaskItem> {
    const requestedRepository = task.sourceListName || task.sourceListId;
    const authorizedRepository = githubWriteAuthorization.getStore()?.authorization.targets
      .find((target) => target.issueNumber === null);
    const repo = requestedRepository?.includes('/')
      ? requestedRepository
      : authorizedRepository
        ? `${authorizedRepository.owner}/${authorizedRepository.repository}`
        : this.repos[0];
    if (!repo) throw new Error('No repository specified — pick a target repo for this issue');

    const [requestedOwner, requestedName] = repo.split('/');
    const { owner, repository: name } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      null,
      'source_repository',
    );
    const routedRepository = `${owner}/${name}`;
    const labels = task.tags?.filter(t => t.type === 'source').map(t => t.name) || [];

    // Include the priority label when creating with a priority set
    if (task.priority && task.priority !== 'none') {
      const priorityLabel = priorityToLabelName(task.priority);
      if (priorityLabel && !labels.includes(priorityLabel)) {
        await ensurePriorityLabelInRepo(this.client!, owner, name, task.priority as Exclude<TaskPriority, 'none'>);
        labels.push(priorityLabel);
      }

    }

    // Include the effort label when creating with effort set
    if (task.effort && task.effort >= 1 && task.effort <= 5) {
      const effortLabel = effortToLabelName(task.effort);
      if (effortLabel && !labels.includes(effortLabel)) {
        await ensureEffortLabelInRepo(this.client!, owner, name, task.effort);
        labels.push(effortLabel);
      }
    }

    const body = {
      title: task.title,
      body: task.description || '',
      labels,
    };

    const res = await this.client!.restFetch(`/repos/${owner}/${name}/issues`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Failed to create issue: ${res.status}`);
    const created = await res.json() as GitHubRestIssue;
    githubWriteAuthorization.getStore()?.createdRoutes.add(
      writeRouteKey(owner, name, created.number),
    );
    const repositoryEvidence = await this.ensureRepositoryEvidence(routedRepository);
    const observedAt = new Date().toISOString();
    return mapRestIssueToTask(
      created,
      routedRepository,
      this.id,
      repositoryEvidence
        ? issueEvidenceFromRest(created, repositoryEvidence, this.client!.origin, observedAt)
        : undefined,
    );
  }

  /**
   * Read-only identity preflight for a token-qualified write lease. The write
   * fence compares this fresh response with the frozen local locator before it
   * can transition a lease to dispatched.
   */
  async preflightWriteRoute(route: {
    targets: ReadonlyArray<{ role: string; owner: string; repository: string; issueNumber: number | null }>;
  }): Promise<{ targets: Record<string, { repositoryStableId: string; issueStableId?: string }> }> {
    const targets: Record<string, { repositoryStableId: string; issueStableId?: string }> = {};
    for (const target of route.targets) {
      if (!target.owner || !target.repository) {
        throw new Error('GitHub write route has no verified repository locator');
      }
      const repository = await this.client!.restFetch(`/repos/${target.owner}/${target.repository}`);
      if (!repository.ok) throw new Error(`GitHub preflight repository failed: ${repository.status}`);
      const repositoryData = await repository.json() as GitHubRestRepository;
      if (
        repositoryData.full_name.toLowerCase()
        !== `${target.owner}/${target.repository}`.toLowerCase()
        || !repositoryData.node_id
      ) {
        throw new Error('GitHub preflight repository identity disagrees with the write locator');
      }
      if (target.issueNumber !== null) {
        const issue = await this.client!.restFetch(
          `/repos/${target.owner}/${target.repository}/issues/${target.issueNumber}`,
        );
      if (!issue.ok) throw new Error(`GitHub preflight issue failed: ${issue.status}`);
      const issueData = await issue.json() as GitHubRestIssue;
        if (issueData.number !== target.issueNumber || !issueData.node_id) {
        throw new Error('GitHub preflight issue identity disagrees with the write locator');
      }
        targets[target.role] = {
        repositoryStableId: repositoryData.node_id,
        issueStableId: issueData.node_id,
      };
      } else {
        targets[target.role] = { repositoryStableId: repositoryData.node_id };
      }
    }
    return { targets };
  }

  async readGitHubWriteOutcome(
    request: GitHubWriteOutcomeReadRequest,
  ): Promise<GitHubWriteOutcomeReadResult> {
    const repository = await this.client!.restFetch(
      `/repos/${request.owner}/${request.repository}`,
    );
    if (!repository.ok) {
      throw new Error(`GitHub outcome repository read failed: ${repository.status}`);
    }
    const repositoryData = await repository.json() as GitHubRestRepository;
    if (
      !repositoryData.node_id
      || repositoryData.full_name.toLowerCase()
        !== `${request.owner}/${request.repository}`.toLowerCase()
    ) {
      throw new Error('GitHub outcome repository identity is ambiguous');
    }
    const issue = await this.client!.restFetch(
      `/repos/${request.owner}/${request.repository}/issues/${request.issueNumber}`,
    );
    if (issue.status === 410) {
      return {
        availability: 'authoritative_absent',
        repositoryStableId: repositoryData.node_id,
      };
    }
    if (!issue.ok) {
      throw new Error(`GitHub outcome issue read failed: ${issue.status}`);
    }
    const issueData = await issue.json() as GitHubRestIssue;
    if (
      !issueData.node_id
      || issueData.number !== request.issueNumber
      || (issueData.state !== 'open' && issueData.state !== 'closed')
    ) {
      throw new Error('GitHub outcome issue identity or state is ambiguous');
    }
    return {
      availability: 'present',
      repositoryStableId: repositoryData.node_id,
      issueStableId: issueData.node_id,
      state: issueData.state,
    };
  }

  async addTagToTask(sourceId: string, tagName: string): Promise<void> {
    const { repo, issueNumber } = parseSourceId(sourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    const { owner, repository: name, issueNumber: authorizedNumber } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      issueNumber,
      'primary_issue',
    );
    const response = await this.client!.restFetch(
      `/repos/${owner}/${name}/issues/${authorizedNumber}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({ labels: [tagName] }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to add issue label: ${response.status}`);
    }
  }

  async removeTagFromTask(sourceId: string, tagName: string): Promise<void> {
    const { repo, issueNumber } = parseSourceId(sourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    const { owner, repository: name, issueNumber: authorizedNumber } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      issueNumber,
      'primary_issue',
    );
    const response = await this.client!.restFetch(
      `/repos/${owner}/${name}/issues/${authorizedNumber}/labels/${encodeURIComponent(tagName)}`,
      { method: 'DELETE' },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove issue label: ${response.status}`);
    }
  }

  async updateTask(sourceId: string, updates: Partial<TaskItem>): Promise<TaskItem> {
    // Legacy checklist items can't be updated via the Issues API
    if (sourceId.startsWith('checklist:')) {
      return { sourceId } as TaskItem;
    }

    const { repo, issueNumber } = parseSourceId(sourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    let owner = requestedOwner;
    let name = requestedName;
    let routedIssueNumber = issueNumber;
    const body: Record<string, unknown> = {};

    if (updates.title) body.title = updates.title;
    if (updates.description !== undefined) body.body = updates.description ?? '';
    const writesLabels = (
      updates.microStatus !== undefined
      && isMicroStatusSyncEnabled((this.config?.settings || {}) as Record<string, unknown>)
    ) || updates.priority !== undefined || updates.effort !== undefined;
    if (Object.keys(body).length > 0 || writesLabels) {
      const route = this.resolveWriteRoute(
        owner,
        name,
        issueNumber,
        'primary_issue',
      );
      owner = route.owner;
      name = route.repository;
      routedIssueNumber = route.issueNumber ?? issueNumber;
    }

    if (
      updates.microStatus !== undefined
      && isMicroStatusSyncEnabled((this.config?.settings || {}) as Record<string, unknown>)
    ) {
      await syncMicroStatusLabels(this.client!, owner, name, routedIssueNumber, updates.microStatus);
    }

    // Sync priority changes back as labels
    if (updates.priority !== undefined) {
      await syncPriorityLabels(this.client!, owner, name, routedIssueNumber, updates.priority);
    }

    // Sync effort changes back as labels
    if (updates.effort !== undefined) {
      await syncEffortLabels(this.client!, owner, name, routedIssueNumber, updates.effort);
    }

    if (Object.keys(body).length > 0) {
      const res = await this.client!.restFetch(`/repos/${owner}/${name}/issues/${routedIssueNumber}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Failed to update issue: ${res.status}`);
      const updated = await res.json();
      return mapRestIssueToTask(updated, `${owner}/${name}`, this.id);
    }

    const res = await this.client!.restFetch(
      `/repos/${owner}/${name}/issues/${routedIssueNumber}`,
    );
    if (!res.ok) throw new Error(`Failed to fetch issue: ${res.status}`);
    const updated = await res.json();
    return mapRestIssueToTask(updated, `${owner}/${name}`, this.id);
  }

  async fetchTaskDependencies(sourceIds: string[], options?: { signal?: AbortSignal }): Promise<{
    dependencies: Array<{ blockerSourceId: string; blockedSourceId: string }>;
    completeBlockedSourceIds: string[];
  }> {
    const nativeSourceIds = sourceIds.filter(isNativeGitHubIssueSourceId);
    const edges = new Map<string, { blockerSourceId: string; blockedSourceId: string }>();
    const completeBlockedSourceIds: string[] = [];
    let nextIndex = 0;
    let fatalError: unknown = null;
    const workerCount = Math.min(5, nativeSourceIds.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!fatalError && nextIndex < nativeSourceIds.length) {
        const blockedSourceId = nativeSourceIds[nextIndex++];
        let blockers: GitHubRestIssue[];
        try {
          blockers = await this.fetchBlockedBy(blockedSourceId, options?.signal);
        } catch (error) {
          if (
            error instanceof GitHubDependencyRequestError
            && (error.status === 404 || error.status === 410)
          ) {
            continue;
          }
          fatalError = error;
          return;
        }
        completeBlockedSourceIds.push(blockedSourceId);
        for (const blocker of blockers) {
          const blockerSourceId = sourceIdFromRestIssue(blocker);
          const key = `${blockerSourceId}\u0000${blockedSourceId}`;
          edges.set(key, { blockerSourceId, blockedSourceId });
        }
      }
    }));
    if (fatalError) throw fatalError;

    return {
      dependencies: [...edges.values()],
      completeBlockedSourceIds,
    };
  }

  async addTaskDependency(blockerSourceId: string, blockedSourceId: string): Promise<void> {
    const blockerRoute = this.resolveSourceRoute(blockerSourceId, 'blocker_issue');
    const blockedRoute = this.resolveSourceRoute(blockedSourceId, 'primary_issue');
    const existingBlockers = await this.fetchBlockedBy(blockedRoute);
    if (existingBlockers.some((issue) => sourceIdFromRestIssue(issue) === blockerRoute)) {
      return;
    }

    const blockerIssue = await this.fetchIssue(blockerRoute);
    if (typeof blockerIssue.id !== 'number') {
      throw new Error('GitHub blocker issue did not include a database ID');
    }

    const { repo, issueNumber } = parseSourceId(blockedRoute);
    const response = await this.client!.restFetch(
      `/repos/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
      {
        method: 'POST',
        headers: { 'X-GitHub-Api-Version': '2026-03-10' },
        body: JSON.stringify({ issue_id: blockerIssue.id }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to add GitHub issue dependency: ${response.status}`);
    }
  }

  async removeTaskDependency(blockerSourceId: string, blockedSourceId: string): Promise<void> {
    const blockerRoute = this.resolveSourceRoute(blockerSourceId, 'blocker_issue');
    const blockedRoute = this.resolveSourceRoute(blockedSourceId, 'primary_issue');
    const existingBlockers = await this.fetchBlockedBy(blockedRoute);
    const blocker = existingBlockers.find(
      (issue) => sourceIdFromRestIssue(issue) === blockerRoute,
    );
    if (!blocker) return;
    if (typeof blocker.id !== 'number') {
      throw new Error('GitHub blocker issue did not include a database ID');
    }

    const { repo, issueNumber } = parseSourceId(blockedRoute);
    const response = await this.client!.restFetch(
      `/repos/${repo}/issues/${issueNumber}/dependencies/blocked_by/${blocker.id}`,
      {
        method: 'DELETE',
        headers: { 'X-GitHub-Api-Version': '2026-03-10' },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to remove GitHub issue dependency: ${response.status}`);
    }
  }

  async createTagInSource(sourceListId: string, tagName: string, color?: string): Promise<void> {
    const [requestedOwner, requestedRepository] = sourceListId.split('/');
    if (!requestedOwner || !requestedRepository) throw new Error(`Invalid repo format: ${sourceListId}`);
    const { owner, repository } = this.resolveWriteRoute(
      requestedOwner,
      requestedRepository,
      null,
      'source_repository',
    );
    await createLabelInRepo(this.client!, owner, repository, tagName, color);
  }

  async completeTask(sourceId: string): Promise<void> {
    return this.closeTaskWithReason(sourceId, 'completed');
  }

  async closeTaskWithReason(sourceId: string, reason: 'completed' | 'not_planned' | 'duplicate'): Promise<void> {
    // Legacy checklist items (from body checkboxes) can't be closed as issues —
    // they're synced via description updates, not the Issues API.
    if (sourceId.startsWith('checklist:')) return;

    const { repo, issueNumber } = parseSourceId(sourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    const { owner, repository: name, issueNumber: authorizedNumber } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      issueNumber,
      'primary_issue',
    );

    await syncMicroStatusLabels(this.client!, owner, name, authorizedNumber!, null);

    const res = await this.client!.restFetch(`/repos/${owner}/${name}/issues/${authorizedNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: reason }),
    });
    // 404/410 means the issue no longer exists — treat as already closed
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw new Error(`Failed to close issue: ${res.status}`);
  }

  async createSubTask(parentSourceId: string, task: Partial<TaskItem>): Promise<TaskItem> {
    const { repo, issueNumber: requestedParentNumber } = parseSourceId(parentSourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    const {
      owner,
      repository: name,
      issueNumber: parentNumber,
    } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      requestedParentNumber,
      'parent_issue',
    );
    const canonicalRepository = `${owner}/${name}`;
    const created = await this.createTask({ ...task, sourceListName: canonicalRepository });

    // Link the new issue as a sub-issue of the parent via GraphQL
    try {
      // Fetch parent node_id via REST
      const parentRes = await this.client!.restFetch(`/repos/${owner}/${name}/issues/${parentNumber}`);
      const parentData = parentRes.ok ? await parentRes.json() : null;
      const parentNodeId = parentData?.node_id;

      // Get child node_id from metadata (set by mapRestIssueToTask) or fetch via REST
      const childNumber = (created.metadata as Record<string, unknown>)?.issueNumber as number | undefined;
      let childNodeId: string | undefined;
      if (childNumber) {
        const childRes = await this.client!.restFetch(`/repos/${owner}/${name}/issues/${childNumber}`);
        const childData = childRes.ok ? await childRes.json() : null;
        childNodeId = childData?.node_id;
      }

      if (!parentNodeId || !childNodeId) {
        throw new Error('GitHub sub-issue identity could not be verified after creation');
      }
      const addSubIssueMutation = `
        mutation($parentId: ID!, $childId: ID!) {
          addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
            issue { id number }
            subIssue { id number }
          }
        }
      `;
      await this.client!.graphqlFetch(addSubIssueMutation, {
        parentId: parentNodeId,
        childId: childNodeId,
      });
    } catch (err) {
      throw new Error('GitHub issue was created but sub-issue linking did not complete', {
        cause: err,
      });
    }

    return created;
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  async addComment(sourceId: string, body: string): Promise<void> {
    if (sourceId.startsWith('checklist:')) return; // Checklist items can't receive comments
    const { repo, issueNumber } = parseSourceId(sourceId);
    const [requestedOwner, requestedName] = repo.split('/');
    const { owner, repository: name, issueNumber: authorizedNumber } = this.resolveWriteRoute(
      requestedOwner,
      requestedName,
      issueNumber,
      'primary_issue',
    );
    const res = await this.client!.restFetch(`/repos/${owner}/${name}/issues/${authorizedNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`Failed to add comment to issue: ${res.status}`);
  }

  async transferTask(
    sourceId: string,
    targetSourceListId: string,
  ): Promise<{ newSourceId: string; identityVerified: true }> {
    const authorizedSourceId = this.resolveSourceRoute(sourceId, 'primary_issue');
    const [targetOwner, targetRepository] = targetSourceListId.split('/');
    const targetRoute = this.resolveWriteRoute(
      targetOwner,
      targetRepository,
      null,
      'target_repository',
    );
    return transferGitHubIssueSafely({
      connectorInstanceId: this.id,
      sourceId: authorizedSourceId,
      targetRepository: `${targetRoute.owner}/${targetRoute.repository}`,
      actor: 'task-move-api',
    });
  }

  async runAuthorizedWrite<T>(
    authorization: GitHubWriteAuthorization,
    write: () => Promise<T>,
  ): Promise<T> {
    if (authorization.connectorInstanceId !== this.id) {
      throw new GitHubWriteFenceError('connector_authorization_mismatch');
    }
    return githubWriteAuthorization.run({
      authorization,
      createdRoutes: new Set<string>(),
    }, write);
  }

  private resolveSourceRoute(
    sourceId: string,
    role: GitHubWriteAuthorization['targets'][number]['role'],
  ): string {
    const { repo, issueNumber } = parseSourceId(sourceId);
    const [owner, repository] = repo.split('/');
    const route = this.resolveWriteRoute(owner, repository, issueNumber, role);
    if (route.issueNumber === null) {
      throw new GitHubWriteFenceError('authorized_issue_route_missing');
    }
    return `${route.owner}/${route.repository}:${route.issueNumber}`;
  }

  private resolveWriteRoute(
    owner: string,
    repository: string,
    issueNumber: number | null,
    role: GitHubWriteAuthorization['targets'][number]['role'],
  ): { owner: string; repository: string; issueNumber: number | null } {
    if (!this.id) return { owner, repository, issueNumber };
    const context = githubWriteAuthorization.getStore();
    const authorization = context?.authorization;
    // GitHub identity is permanently NodeID-first: every mutation must carry a
    // fenced authorization, there is no unfenced locator route.
    if (!authorization) {
      throw new GitHubWriteFenceError('direct_write_requires_fence');
    }
    if (authorization.connectorInstanceId !== this.id) {
      throw new GitHubWriteFenceError('connector_authorization_mismatch');
    }
    const target = authorization.targets.find((candidate) => candidate.role === role);
    if (target) {
      if ((issueNumber === null) !== (target.issueNumber === null)) {
        throw new GitHubWriteFenceError('authorized_route_kind_mismatch');
      }
      return target;
    }
    if (
      issueNumber !== null
      && context.createdRoutes.has(writeRouteKey(owner, repository, issueNumber))
    ) {
      return { owner, repository, issueNumber };
    }
    throw new GitHubWriteFenceError('authorized_route_mismatch');
  }

  canTransferTask(sourceId: string, targetSourceListId: string): Promise<boolean> {
    return canTransferGitHubIssueSafely(this.id, sourceId, targetSourceListId);
  }

  async refreshTransferIdentity(
    sourceId: string,
    targetSourceListId: string,
  ): Promise<TransferIdentityRefresh> {
    const { repo } = parseSourceId(sourceId);
    const [issue, sourceRepository, targetRepository] = await Promise.all([
      this.fetchIssue(sourceId),
      this.fetchRepositoryEvidence(repo),
      this.fetchRepositoryEvidence(targetSourceListId),
    ]);
    if (!sourceRepository || !targetRepository) {
      throw new Error('GitHub repository identity evidence is unavailable');
    }
    const observedAt = new Date().toISOString();
    const issueEvidence = issueEvidenceFromRest(
      issue,
      sourceRepository,
      this.client!.origin,
      observedAt,
    );
    if (!issueEvidence) {
      throw new Error('GitHub issue identity evidence is unavailable');
    }
    return {
      task: mapRestIssueToTask(issue, repo, this.id, issueEvidence),
      sourceLists: [
        { sourceId: repo, evidence: { entity: sourceRepository } },
        { sourceId: targetSourceListId, evidence: { entity: targetRepository } },
      ],
    };
  }

  private async fetchIssue(sourceId: string): Promise<GitHubRestIssue> {
    const { repo, issueNumber } = parseSourceId(sourceId);
    const response = await this.client!.restFetch(`/repos/${repo}/issues/${issueNumber}`, {
      headers: { 'X-GitHub-Api-Version': '2026-03-10' },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub issue ${sourceId}: ${response.status}`);
    }
    return response.json() as Promise<GitHubRestIssue>;
  }

  private async fetchBlockedBy(
    blockedSourceId: string,
    signal?: AbortSignal,
  ): Promise<GitHubRestIssue[]> {
    const { repo, issueNumber } = parseSourceId(blockedSourceId);
    const blockers: GitHubRestIssue[] = [];
    let page = 1;

    while (true) {
      const response = await this.client!.restFetch(
        `/repos/${repo}/issues/${issueNumber}/dependencies/blocked_by?per_page=100&page=${page}`,
        {
          headers: { 'X-GitHub-Api-Version': '2026-03-10' },
          signal,
        },
      );
      if (!response.ok) {
        throw new GitHubDependencyRequestError(
          `Failed to fetch GitHub issue dependencies for ${blockedSourceId}: ${response.status}`,
          response.status,
        );
      }
      const pageItems = await response.json() as GitHubRestIssue[];
      blockers.push(...pageItems);
      if (pageItems.length < 100) break;
      page++;
    }

    return blockers;
  }

  // ─── Private: Fetch Issues ──────────────────────────────────────────────

  private recordDependencyReadMode(
    mode: SourceTaskDependencyReadMode,
    repo: string,
  ): void {
    if (this.dependencyReadMode && this.dependencyReadMode !== mode) {
      throw new Error(
        `GitHub dependency read mode changed from ${this.dependencyReadMode} to ${mode}`,
      );
    }
    if (!this.dependencyReadMode) {
      connectorLogger.info({
        connectorId: this.id,
        dependencyReadMode: mode,
        repo,
      }, 'GitHub dependency read mode selected');
    }
    this.dependencyReadMode = mode;
  }

  private async *fetchIssuesFromRepo(
    repo: string,
    since?: Date,
    options?: FetchTaskOptions,
    useRestDependencyFallback = false,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    const [owner, name] = repo.split('/');
    const issueStates = '[OPEN, CLOSED]';
    const dependencyFields = options?.dependencyGeneration && !useRestDependencyFallback
      ? `
               blockedBy(first: ${BLOCKED_BY_PAGE_SIZE}) {
                 totalCount
                 pageInfo { hasNextPage endCursor }
                 nodes {
                   id
                   number
                   url
                   repository {
                     id
                     nameWithOwner
                     url
                   }
                 }
               }`
      : '';

    const query = `
      query($owner: String!, $name: String!, $since: DateTime, $cursor: String) {
        repository(owner: $owner, name: $name) {
          id
          nameWithOwner
          url
          issues(
            first: 50
            after: $cursor
            states: ${issueStates}
            filterBy: { since: $since }
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              number
              title
              body
              state
              stateReason
              createdAt
              updatedAt
              closedAt
              url
              labels(first: 20) { nodes { name color } }
              assignees(first: 5) { nodes { login } }
              milestone { title }
              parent {
                id
                number
                title
                url
                repository {
                  id
                  nameWithOwner
                  url
                }
              }
              ${dependencyFields}
            }
          }
        }
      }
    `;

    let stagedPageCount = 0;
    try {
      const variables: Record<string, unknown> = { owner, name };
      if (since) variables.since = since.toISOString();

      let hasNextPage = true;
      while (hasNextPage) {
        const data = await this.client!.graphqlFetch(
          query,
          variables,
          { signal: options?.signal },
        );
        if (data.errors?.length) {
          throw new GitHubGraphQLDependencyError(data.errors.map(({ message }) => message));
        }
        const repositoryData = data?.data?.repository;
        if (!repositoryData?.id || !repositoryData.nameWithOwner) {
          throw new Error('GraphQL repository identity is unavailable');
        }
        const observedAt = new Date().toISOString();
        const repositoryEvidence = repositoryEvidenceFromGraphQL(
          repositoryData,
          this.client!.origin,
          observedAt,
        );
        this.repositoryEvidenceBySourceId.set(repo, repositoryEvidence);
        this.repositoryEvidenceBySourceId.set(repositoryData.nameWithOwner, repositoryEvidence);
        this.repositoryCanonicalNameBySourceId.set(repo, repositoryData.nameWithOwner);
        const issuesConnection = repositoryData.issues;
        const issues = issuesConnection?.nodes || [];
        if (options?.dependencyGeneration && !useRestDependencyFallback) {
          this.recordDependencyReadMode('graphql-bulk', repositoryData.nameWithOwner);
        }
        hasNextPage = issuesConnection?.pageInfo?.hasNextPage || false;
        if (hasNextPage && issuesConnection?.pageInfo?.endCursor) {
          variables.cursor = issuesConnection.pageInfo.endCursor;
        }

        const pageTasks: TaskItem[] = [];
        const dependencySnapshot: SourceTaskDependencySnapshot = {
          dependencies: [],
          completeBlockedSourceIds: [],
          blockedIdentityEvidence: [],
        };
        for (const issue of issues) {
          const blockedIdentityEvidence = issueEvidenceFromGraphQL(
            issue.id,
            issue.number,
            issue.url,
            repositoryEvidence,
            this.client!.origin,
            observedAt,
          );
          if (options?.dependencyGeneration && !useRestDependencyFallback) {
            const blockedSourceId = `${repo}:${issue.number}`;
            dependencySnapshot.completeBlockedSourceIds.push(blockedSourceId);
            dependencySnapshot.blockedIdentityEvidence!.push({
              sourceId: blockedSourceId,
              evidence: blockedIdentityEvidence,
              state: 'verified',
            });
            const { blockers, overflowFetchCount } = await this.fetchAllGraphQLBlockers(
              repositoryData.nameWithOwner,
              issue,
              options.signal,
            );
            if (overflowFetchCount > 0) {
              dependencySnapshot.overflowFetchCount =
                (dependencySnapshot.overflowFetchCount ?? 0) + overflowFetchCount;
            }
            for (const blocker of blockers) {
              const canonicalRepo = blocker.repository.nameWithOwner;
              const blockerRepo = canonicalRepo.toLowerCase()
                === repositoryData.nameWithOwner.toLowerCase()
                ? repo
                : await this.resolveConfiguredRepositoryName(canonicalRepo);
              dependencySnapshot.dependencies.push({
                blockerSourceId: `${blockerRepo}:${blocker.number}`,
                blockedSourceId,
                blockerIdentityEvidence: issueEvidenceFromGraphQL(
                  blocker.id,
                  blocker.number,
                  blocker.url,
                  repositoryEvidenceFromGraphQL(
                    blocker.repository,
                    this.client!.origin,
                    observedAt,
                  ),
                  this.client!.origin,
                  observedAt,
                ),
                blockerIdentityEvidenceState: 'verified',
              });
            }
          }
          const task = mapGraphQLIssueToTask(
            issue,
            repo,
            this.id,
            blockedIdentityEvidence,
            issue.parent?.id
              && issue.parent.repository.id
              && issue.parent.repository.nameWithOwner
              && issue.parent.repository.url
              ? issueEvidenceFromGraphQL(
                  issue.parent.id,
                  issue.parent.number,
                  issue.parent.url,
                  repositoryEvidenceFromGraphQL(
                    {
                      id: issue.parent.repository.id,
                      nameWithOwner: issue.parent.repository.nameWithOwner,
                      url: issue.parent.repository.url,
                    },
                    this.client!.origin,
                    observedAt,
                  ),
                  this.client!.origin,
                  observedAt,
                )
              : undefined,
          );
          pageTasks.push(task);
        }
        if (options?.dependencyGeneration) {
          const stagedSnapshot = useRestDependencyFallback
            ? await this.fetchRestDependencyPage(repo, issues, options.signal)
            : dependencySnapshot;
          await options.dependencyGeneration.stagePage(
            stagedSnapshot,
            useRestDependencyFallback ? 'rest-fallback' : 'graphql-bulk',
          );
          stagedPageCount++;
        }
        yield pageTasks;
      }
    } catch (error) {
      if (
        error instanceof GitHubGraphQLDependencyError
        && error.isCapabilityUnavailable
        && this.client!.origin.hostKey !== 'github.com'
        && !useRestDependencyFallback
      ) {
        this.recordDependencyReadMode('rest-fallback', repo);
        connectorLogger.warn({
          connectorId: this.id,
          dependencyReadMode: 'rest-fallback',
          repo,
          reason: 'blockedBy-field-unavailable',
        }, 'GitHub GraphQL dependency fields unavailable; using GHES REST fallback');
        yield* this.fetchIssuesFromRepo(repo, since, options, true);
        return;
      }
      if (useRestDependencyFallback && stagedPageCount === 0) {
        yield* this.fetchIssuesViaRest(repo, since, options);
        return;
      }
      if (
        !options?.dependencyGeneration
        || options.dependencyGeneration.failureMode === 'best-effort'
      ) {
        yield* this.fetchIssuesViaRest(repo, since, options);
        return;
      }
      throw error;
    }
  }

  private async fetchAllGraphQLBlockers(
    repo: string,
    issue: import('./github-client').GraphQLIssue,
    signal?: AbortSignal,
  ): Promise<{
    blockers: import('./github-client').GraphQLBlockedByIssue[];
    overflowFetchCount: number;
  }> {
    const blockers = [...(issue.blockedBy?.nodes ?? [])];
    let overflowFetchCount = 0;
    let pageInfo = issue.blockedBy?.pageInfo;
    const totalCount = issue.blockedBy?.totalCount ?? blockers.length;
    if (blockers.length > totalCount) {
      throw new Error(`GitHub blockedBy returned more nodes than totalCount for ${repo}:${issue.number}`);
    }

    const [owner, name] = repo.split('/');
    const query = `
      query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
        repository(owner: $owner, name: $name) {
          id
          nameWithOwner
          url
          issue(number: $number) {
            number
            blockedBy(first: ${BLOCKED_BY_PAGE_SIZE}, after: $cursor) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                number
                url
                repository {
                  id
                  nameWithOwner
                  url
                }
              }
            }
          }
        }
      }
    `;

    while (pageInfo?.hasNextPage) {
      if (!pageInfo.endCursor) {
        throw new Error(`GitHub blockedBy pagination cursor missing for ${repo}:${issue.number}`);
      }
      const data = await this.client!.graphqlFetch(
        query,
        {
          owner,
          name,
          number: issue.number,
          cursor: pageInfo.endCursor,
        },
        { signal },
      );
      overflowFetchCount++;
      if (data.errors?.length) {
        throw new GitHubGraphQLDependencyError(data.errors.map(({ message }) => message));
      }
      const connection = data.data?.repository?.issue?.blockedBy;
      if (!connection) {
        throw new Error(`GitHub blockedBy overflow page missing for ${repo}:${issue.number}`);
      }
      blockers.push(...connection.nodes);
      pageInfo = connection.pageInfo;
    }
    if (blockers.length !== totalCount) {
      throw new Error(
        `GitHub blockedBy pagination incomplete for ${repo}:${issue.number}: expected ${totalCount}, received ${blockers.length}`,
      );
    }
    return { blockers, overflowFetchCount };
  }

  private async *fetchIssuesViaRest(
    repo: string,
    since?: Date,
    options?: FetchTaskOptions,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    const [owner, name] = repo.split('/');
    const repositoryEvidence = await this.ensureRepositoryEvidence(repo);
    const state = 'all';
    const baseUrl = `/repos/${owner}/${name}/issues?state=${state}&per_page=100`;
    const sinceParam = since ? `&since=${since.toISOString()}` : '';
    let page = 1;

    while (true) {
      const url = `${baseUrl}${sinceParam}&page=${page}`;
      const res = await this.client!.restFetch(url, { signal: options?.signal });
      if (!res.ok) {
        throw new Error(`GitHub issue fetch failed with HTTP ${res.status}`);
      }
      const issues = await res.json() as GitHubRestIssue[];
      if (!issues.length) break;

      const nativeIssues = issues.filter((issue) => !issue.pull_request);
      const pageTasks = nativeIssues
        .map((issue: GitHubRestIssue) => {
          const observedAt = new Date().toISOString();
          return mapRestIssueToTask(
            issue,
            repo,
            this.id,
            repositoryEvidence
              ? issueEvidenceFromRest(
                  issue,
                  repositoryEvidence,
                  this.client!.origin,
                  observedAt,
                )
              : undefined,
          );
        });

      // NOTE: Markdown checkboxes from issue bodies are no longer synced as tasks.

      if (options?.dependencyGeneration) {
        const dependencySnapshot = await this.fetchRestDependencyPage(
          repo,
          nativeIssues,
          options.signal,
        );
        await options.dependencyGeneration.stagePage(
          dependencySnapshot,
          'rest-fallback',
        );
      }
      yield pageTasks;

      if (issues.length < 100) break;
      page++;
    }

  }

  private async fetchRestDependencyPage(
    repo: string,
    issues: Array<{ number: number }>,
    signal?: AbortSignal,
  ): Promise<SourceTaskDependencySnapshot> {
    const snapshot: SourceTaskDependencySnapshot = {
      dependencies: [],
      completeBlockedSourceIds: [],
      blockedIdentityEvidence: [],
    };
    let nextIndex = 0;
    let fatalError: unknown;
    const workerCount = Math.min(5, issues.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!fatalError && nextIndex < issues.length) {
        const issue = issues[nextIndex++];
        const blockedSourceId = `${repo}:${issue.number}`;
        try {
          const blockers = await this.fetchBlockedBy(blockedSourceId, signal);
          snapshot.completeBlockedSourceIds.push(blockedSourceId);
          snapshot.blockedIdentityEvidence!.push({
            sourceId: blockedSourceId,
            state: 'missing',
          });
          for (const blocker of blockers) {
            snapshot.dependencies.push({
              blockerSourceId: await this.normalizeDependencySourceId(
                sourceIdFromRestIssue(blocker),
              ),
              blockedSourceId,
              blockerIdentityEvidenceState: 'missing',
            });
          }
        } catch (error) {
          fatalError = error;
        }
      }
    }));
    if (fatalError) throw fatalError;
    return snapshot;
  }

  private async ensureRepositoryEvidence(
    repo: string,
  ): Promise<ExternalIdentityObservation | undefined> {
    const existing = this.repositoryEvidenceBySourceId.get(repo);
    if (existing) return existing;
    return this.fetchRepositoryEvidence(repo);
  }

  private async fetchRepositoryEvidence(
    repo: string,
  ): Promise<ExternalIdentityObservation | undefined> {
    const [owner, name] = repo.split('/');
    const response = await this.client!.restFetch(`/repos/${owner}/${name}`);
    if (!response.ok) return undefined;
    const repository = await response.json() as GitHubRestRepository;
    this.repositoryCanonicalNameBySourceId.set(repo, repository.full_name);
    const evidence = repositoryEvidenceFromRest(
      repository,
      this.client!.origin,
      new Date().toISOString(),
    );
    if (evidence) {
      this.repositoryEvidenceBySourceId.set(repo, evidence);
      this.repositoryEvidenceBySourceId.set(repository.full_name, evidence);
    }
    return evidence;
  }

  private async resolveConfiguredRepositoryName(canonicalRepository: string): Promise<string> {
    const canonicalLower = canonicalRepository.toLowerCase();
    const directMatch = this.repos.find(
      (configuredRepository) => configuredRepository.toLowerCase() === canonicalLower,
    );
    if (directMatch) return directMatch;

    const mappedMatch = [...this.repositoryCanonicalNameBySourceId].find(
      ([, observedCanonical]) => observedCanonical.toLowerCase() === canonicalLower,
    );
    if (mappedMatch) return mappedMatch[0];

    let nextRepositoryIndex = 0;
    const workerCount = Math.min(REPO_FETCH_CONCURRENCY, this.repos.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextRepositoryIndex < this.repos.length) {
        const configuredRepository = this.repos[nextRepositoryIndex++];
        if (this.repositoryCanonicalNameBySourceId.has(configuredRepository)) continue;
        let fetchPromise = this.repositoryCanonicalNameFetchBySourceId.get(configuredRepository);
        if (!fetchPromise) {
          fetchPromise = this.fetchRepositoryEvidence(configuredRepository)
            .then(() => this.repositoryCanonicalNameBySourceId.get(configuredRepository));
          this.repositoryCanonicalNameFetchBySourceId.set(configuredRepository, fetchPromise);
        }
        try {
          if (await fetchPromise) continue;
          this.repositoryCanonicalNameFetchBySourceId.delete(configuredRepository);
        } catch (error) {
          this.repositoryCanonicalNameFetchBySourceId.delete(configuredRepository);
          throw error;
        }
      }
    }));

    const resolvedMatch = [...this.repositoryCanonicalNameBySourceId].find(
      ([, observedCanonical]) => observedCanonical.toLowerCase() === canonicalLower,
    );
    if (resolvedMatch) return resolvedMatch[0];

    const unresolvedRepositories = this.repos.filter(
      (configuredRepository) =>
        !this.repositoryCanonicalNameBySourceId.has(configuredRepository),
    );
    if (unresolvedRepositories.length > 0) {
      throw new Error(
        `Cannot resolve GitHub dependency repository aliases for: ${
          unresolvedRepositories.join(', ')
        }`,
      );
    }
    return canonicalRepository;
  }

  private async normalizeDependencySourceId(sourceId: string): Promise<string> {
    const { repo, issueNumber } = parseSourceId(sourceId);
    return `${await this.resolveConfiguredRepositoryName(repo)}:${issueNumber}`;
  }

}

// ─── Factory ──────────────────────────────────────────────────────────────

function sourceIdFromRestIssue(issue: GitHubRestIssue): string {
  const repositoryUrl = issue.repository_url;
  if (repositoryUrl) {
    const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (match) return `${match[1]}:${issue.number}`;
  }

  const match = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/);
  if (!match) {
    throw new Error(`Could not determine repository for GitHub issue #${issue.number}`);
  }
  return `${match[1]}:${issue.number}`;
}

class GitHubDependencyRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class GitHubGraphQLDependencyError extends Error {
  readonly isCapabilityUnavailable: boolean;

  constructor(readonly messages: string[]) {
    super(`GitHub GraphQL dependency query failed: ${messages.join('; ')}`);
    this.isCapabilityUnavailable = messages.some((message) =>
      /(?:Cannot query field|field .* (?:does not exist|doesn't exist|is undefined|not found)).*blockedBy|blockedBy.*(?:does not exist|doesn't exist|is undefined|not found)/i
        .test(message));
  }
}

export const githubIssuesFactory: ConnectorFactory = {
  create: () => new GitHubIssuesConnector(),
  notificationTypes: GITHUB_NOTIFICATION_TYPES,
};
