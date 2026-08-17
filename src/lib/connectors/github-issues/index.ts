import type {
  IConnector,
  ConnectorFactory,
  TransferIdentityRefresh,
} from '../index';
import {
  ConnectorWritebackError,
  type NotificationWritebackAction,
} from '../notification-writeback-contract';
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
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
} from '@/lib/external-identities/types';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import db, { sqlite } from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { GITHUB_ISSUES_TASK_AUTHORITY } from '../task-source-profiles';
import { mergeAsyncStreams } from '../task-page-stream';

import { createGitHubClient } from './github-client';
import type { GitHubClient, GitHubRestIssue, GitHubRestRepository, GitHubNotification, GitHubProjectV2, GitHubProjectV2Item } from './github-client';
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
  getGitHubIdentityModeSnapshot,
  GitHubWriteFenceError,
  type GitHubWriteAuthorization,
  type GitHubWriteOutcomeReadRequest,
  type GitHubWriteOutcomeReadResult,
} from '@/lib/external-identities';
import { assertUniqueGitHubProjectIdentities } from '@/lib/sync/github-project-association-identity';

export type { GitHubClient } from './github-client';
export type { GraphQLIssue, GitHubRestIssue, GitHubNotification, GitHubProjectV2, GitHubProjectV2Item } from './github-client';
export {
  executeGitHubRepositoryRepoint,
  getGitHubRepositoryRepointStatus,
  inspectGitHubRepointBackup,
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

/** Data returned from project sync to create hub projects and link tasks */
export interface GitHubProjectAssociation {
  project: GitHubProjectV2;
  membershipState: 'complete' | 'partial' | 'inaccessible';
  /** Task sourceIds that belong to this project */
  taskSourceIds: string[];
  taskIdentityEvidence: Array<{
    sourceId: string;
    evidence: ExternalIdentityEvidence;
  }>;
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

interface GitHubNotificationPollState {
  checkpointSince?: string;
  pendingSince?: string;
  continuationUrl?: string;
  etag?: string;
  lastModified?: string;
  nextPollAt?: string;
  pollIntervalSeconds?: number;
}

interface GitHubNotificationPollCompletion {
  checkpointSince: string;
  etag?: string;
  lastModified?: string;
  pollIntervalSeconds: number;
  nextPollAt: string;
}

const GITHUB_NOTIFICATION_PAGE_SIZE = 50;
const DEFAULT_GITHUB_POLL_INTERVAL_SECONDS = 60;
const KNOWN_GITHUB_NOTIFICATION_REASONS = new Set([
  'approval_requested',
  'assign',
  'author',
  'ci_activity',
  'comment',
  'invitation',
  'manual',
  'mention',
  'review_requested',
  'security_alert',
  'state_change',
  'subscribed',
  'team_mention',
]);

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
  private fetchNotificationsEnabled = true;
  private notificationReasons: string[] = [];
  private participatingOnly = false;
  private authenticatedUser = '';
  private notificationPollState: GitHubNotificationPollState = {};
  private pendingNotificationPollCompletion: GitHubNotificationPollCompletion | null = null;
  private repositoryEvidenceBySourceId = new Map<string, ExternalIdentityObservation>();
  private repositoryFetchStateBySourceId = new Map<string, GitHubRepositoryFetchState>();
  private repositoryCanonicalNameBySourceId = new Map<string, string>();
  private repositoryCanonicalNameFetchBySourceId = new Map<string, Promise<string | undefined>>();
  private dependencyReadMode: SourceTaskDependencyReadMode | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    const settings = config.settings as unknown as GitHubConfig;
    const token = config.credentials.token || config.credentials.pat || settings.token || '';
    this.client = createGitHubClient(token, settings.apiOrigin);
    this.repos = settings.repos || [];
    this.fetchNotificationsEnabled = settings.fetchNotifications ?? true;
    this.notificationReasons = settings.notificationReasons || [];
    this.participatingOnly = settings.participatingOnly ?? false;
    this.authenticatedUser = settings.authenticatedUser || '';
    this.notificationPollState = settings.notificationPollState || {};
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
          const updatedSettings = { ...currentSettings, authenticatedUser: user.login };
          await db.update(connectorConfigs)
            .set({ settings: JSON.stringify(updatedSettings) })
            .where(eq(connectorConfigs.id, this.config.id));
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
    this.fetchNotificationsEnabled = true;
    this.notificationReasons = [];
    this.participatingOnly = false;
    this.notificationPollState = {};
    this.repositoryEvidenceBySourceId.clear();
    this.repositoryFetchStateBySourceId.clear();
    this.repositoryCanonicalNameBySourceId.clear();
    this.repositoryCanonicalNameFetchBySourceId.clear();
    this.dependencyReadMode = null;
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
      const { metadataBySourceId, draftTasks } = await this.fetchProjectTaskContext();
      const incompleteProject = this.lastProjectAssociations.find(
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
    return this.lastProjectAssociations;
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

  /** Associations discovered by the most recent fetchTasks() iteration */
  private lastProjectAssociations: GitHubProjectAssociation[] = [];

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    if (!this.fetchNotificationsEnabled) {
      return [];
    }

    const cutoff = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const notifications = await this.fetchGitHubNotifications(cutoff);

    return notifications.map((notification) => ({
      id: `gh-notif-${notification.id}`,
      sourceId: notification.id,
      connectorType: this.type,
      connectorInstanceId: this.id,
      title: `[${notification.subject.type}] ${notification.subject.title}`,
      body: `${notification.reason} in ${notification.repository.full_name}`,
      level: this.mapGitHubLevel(notification.reason),
      category: this.mapGitHubCategory(notification.reason, notification.subject.type),
      isRead: !notification.unread,
      isActionable: ['review_requested', 'assign', 'mention', 'security_alert'].includes(notification.reason),
      actionUrl: this.buildGitHubWebUrl(notification),
      receivedAt: notification.updated_at,
      sourceState: 'active',
      sourceActivityAt: notification.updated_at,
      sourceActivityKey: `${notification.id}:${notification.updated_at}`,
      reopenPolicy: 'handled',
      hubProjectIds: [],
      tags: [],
      metadata: {
        notificationId: notification.id,
        reason: notification.reason,
        reasonKnown: KNOWN_GITHUB_NOTIFICATION_REASONS.has(
          notification.reason.toLowerCase(),
        ),
        subjectType: notification.subject.type,
        subjectUrl: notification.subject.url,
        repository: notification.repository.full_name,
        unread: notification.unread,
        updatedAt: notification.updated_at,
        lastReadAt: notification.last_read_at,
      },
    }));
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.writeNotificationAction(notificationId, 'mark_read');
  }

  async writeNotificationAction(
    notificationId: string,
    action: NotificationWritebackAction,
    signal?: AbortSignal,
  ): Promise<void> {
    const threadId = notificationId.startsWith('gh-notif-')
      ? notificationId.slice('gh-notif-'.length)
      : notificationId;
    if (!/^\d+$/.test(threadId)) {
      throw new ConnectorWritebackError(
        `Invalid GitHub notification thread ID: ${notificationId}`,
        false,
      );
    }
    const path = action === 'mute' || action === 'unmute'
      ? `/notifications/threads/${threadId}/subscription`
      : `/notifications/threads/${threadId}`;
    const request: RequestInit = action === 'mark_read'
      ? { method: 'PATCH', signal }
      : action === 'mark_done'
        ? { method: 'DELETE', signal }
        : {
            method: 'PUT',
            body: JSON.stringify({ ignored: action === 'mute' }),
            signal,
          };
    const res = await this.client!.restFetch(path, request);
    if (res.ok) return;

    const retryAt = this.getGitHubRetryAt(res);
    const retryable = res.status === 429
      || res.status >= 500
      || (res.status === 403 && retryAt !== undefined);
    throw new ConnectorWritebackError(
      `GitHub notification ${action} failed with HTTP ${res.status}`,
      retryable,
      retryAt,
      res.status,
    );
  }

  async getActiveAlertSourceIds(): Promise<null> {
    // GitHub's notifications feed is incremental, not an authoritative source-state snapshot.
    return null;
  }

  async commitNotificationFetch(): Promise<void> {
    const completion = this.pendingNotificationPollCompletion;
    if (!completion) return;
    await this.persistNotificationPollState({
      checkpointSince: completion.checkpointSince,
      pendingSince: undefined,
      continuationUrl: undefined,
      pollIntervalSeconds: completion.pollIntervalSeconds,
      nextPollAt: completion.nextPollAt,
      etag: completion.etag,
      lastModified: completion.lastModified,
    });
    this.pendingNotificationPollCompletion = null;
  }

  /**
   * Per-ID reconciliation for notifications that might have been resolved
   * upstream (PR merged, issue closed, review submitted).
   */
  async reconcileAlerts(activeSourceIds: string[]): Promise<import('../index').AlertReconciliation[]> {
    const results: import('../index').AlertReconciliation[] = [];
    const CONCURRENCY = 5;

    for (let i = 0; i < activeSourceIds.length; i += CONCURRENCY) {
      const batch = activeSourceIds.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(sourceId => this.reconcileSingleAlert(sourceId))
      );
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
      // Yield between batches to keep event loop responsive
      if (i + CONCURRENCY < activeSourceIds.length) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }

    return results;
  }

  /** Reconcile a single alert — extracted for parallel execution */
  private async reconcileSingleAlert(sourceId: string): Promise<import('../index').AlertReconciliation | null> {
      // Extract the GitHub notification thread ID
      const match = sourceId.match(/^[^:]*:gh-notif-(.+)$/);
      if (!match) return null;

      const threadId = match[1];
      try {
        const res = await this.client!.restFetch(`/notifications/threads/${threadId}`);
        if (res.status === 404) {
          return { sourceId, resolved: true, reason: 'notification_deleted' };
        }
        if (!res.ok) return null;

        const thread = await res.json() as { unread: boolean; subject: { url?: string; type?: string }; reason: string };

        // If GitHub already marked it as read and it's not a high-signal type, resolve
        if (!thread.unread && !['review_requested', 'assign', 'security_alert'].includes(thread.reason)) {
          return { sourceId, resolved: true, reason: 'read_upstream' };
        }

        // For PRs: check if the PR is merged/closed, or if review is no longer requested
        if (thread.subject?.type === 'PullRequest' && thread.subject?.url) {
          const prPath = thread.subject.url.replace('https://api.github.com', '');
          const prRes = await this.client!.restFetch(prPath);
          if (prRes.ok) {
            const pr = await prRes.json() as {
              state: string;
              merged: boolean;
              requested_reviewers?: Array<{ login: string }>;
              requested_teams?: Array<{ slug: string }>;
            };
            if (pr.state === 'closed' || pr.merged) {
              return {
                sourceId,
                resolved: true,
                reason: pr.merged ? 'pr_merged' : 'pr_closed',
              };
            }

            // If this was a review_requested notification and the user is no
            // longer in the requested reviewers list, their review is done
            if (thread.reason === 'review_requested' && this.authenticatedUser) {
              const pendingForUser = (pr.requested_reviewers || [])
                .some(r => r.login.toLowerCase() === this.authenticatedUser.toLowerCase());
              if (!pendingForUser) {
                return {
                  sourceId,
                  resolved: true,
                  reason: 'review_submitted',
                };
              }
            }
          }
        }

        // For issues: check if closed
        if (thread.subject?.type === 'Issue' && thread.subject?.url) {
          const issueRes = await this.client!.restFetch(thread.subject.url.replace('https://api.github.com', ''));
          if (issueRes.ok) {
            const issue = await issueRes.json() as { state: string };
            if (issue.state === 'closed') {
              return { sourceId, resolved: true, reason: 'issue_closed' };
            }
          }
        }

        // Still active
        return { sourceId, resolved: false };
      } catch {
        // On error, don't resolve — fail-open
        return null;
      }
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

  canTransferTask(sourceId: string, targetSourceListId: string): boolean {
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

  // ─── Private: GitHub Projects V2 ─────────────────────────────────────────

  /** Tracks project ownership so item queries use the correct owner type/login */
  private projectOwnerMap = new Map<string, { type: 'user' | 'organization'; login: string }>();

  private async fetchProjectsV2(): Promise<GitHubProjectV2[]> {
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
        const data = await this.client!.graphqlFetchAny(viewerQuery, variables);
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
    for (const repo of this.repos) {
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
          const data = await this.client!.graphqlFetchAny(repoProjectsQuery, vars);
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
            const data = await this.client!.graphqlFetchAny(orgProjectsQuery, vars);
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
    project: Pick<GitHubProjectV2, 'id' | 'number'>,
  ): Promise<{
    items: GitHubProjectV2Item[];
    state: GitHubProjectAssociation['membershipState'];
  }> {
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
        const userRes = await this.client!.restFetch('/user');
        if (!userRes.ok) return { items, state: 'inaccessible' };
        const userData = await userRes.json();
        login = userData.login;
      }

      let hasNextPage = true;
      const variables: Record<string, unknown> = { login, projectNumber };
      while (hasNextPage) {
        const data = await this.client!.graphqlFetchAny(query, variables);
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

  private async fetchProjectTaskContext(): Promise<{
    metadataBySourceId: Map<string, Array<{
      projectNumber: number;
      projectTitle: string;
      sourceId: string;
      fields: Record<string, string>;
    }>>;
    draftTasks: TaskItem[];
  }> {
    const projects = await this.fetchProjectsV2();
    this.lastProjectAssociations = [];
    const metadataBySourceId = new Map<string, Array<{
      projectNumber: number;
      projectTitle: string;
      sourceId: string;
      fields: Record<string, string>;
    }>>();
    const draftTasks: TaskItem[] = [];

    for (const project of projects) {
      const membership = await this.fetchProjectItemsForProject(project);
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

          const isConfiguredRepo = this.repos.some(
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
            const repositoryEvidence = this.repositoryEvidenceBySourceId.get(repo);
            if (repositoryEvidence) {
              association.taskIdentityEvidence.push({
                sourceId: issueSourceId,
                evidence: issueEvidenceFromGraphQL(
                  item.content.id,
                  item.content.number,
                  item.content.url,
                  repositoryEvidence,
                  this.client!.origin,
                  new Date().toISOString(),
                ),
              });
            }
          }
        } else if (item.content.__typename === 'DraftIssue') {
          const task = this.draftIssueToTask(item, project, projectFields);
          draftTasks.push(task);
          association.taskSourceIds.push(task.sourceId);
        }
      }

      this.lastProjectAssociations.push(association);
    }

    return { metadataBySourceId, draftTasks };
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

  private projectItemToTask(item: GitHubProjectV2Item, project: GitHubProjectV2, repo: string): TaskItem {
    const content = item.content!;
    const labelNodes = content.labels?.nodes || [];
    const projectFields = this.extractProjectFields(item);

    return {
      id: randomUUID(),
      sourceId: `${repo}:${content.number}`,
      connectorType: this.type,
      connectorInstanceId: this.id,
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
        source: this.type,
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

  private draftIssueToTask(item: GitHubProjectV2Item, project: GitHubProjectV2, projectFields: Record<string, string>): TaskItem {
    const content = item.content!;
    return {
      id: randomUUID(),
      sourceId: `project:${project.number}:draft:${item.id}`,
      connectorType: this.type,
      connectorInstanceId: this.id,
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

  // ─── Private: Notifications ─────────────────────────────────────────────

  private async fetchGitHubNotifications(cutoff: Date): Promise<GitHubNotification[]> {
    const now = new Date();
    const nextPollAt = this.notificationPollState.nextPollAt
      ? new Date(this.notificationPollState.nextPollAt)
      : null;
    if (nextPollAt && nextPollAt > now) return [];

    const notifications = new Map<string, GitHubNotification>();
    const reasonFilter = new Set(this.notificationReasons.map((reason) => reason.toLowerCase()));
    const pollStartedAt = now.toISOString();
    const cutoffIso = this.notificationPollState.pendingSince
      || this.notificationPollState.checkpointSince
      || cutoff.toISOString();
    const participatingParam = this.participatingOnly ? '&participating=true' : '';
    let nextUrl: string | null =
      `/notifications?all=true&per_page=${GITHUB_NOTIFICATION_PAGE_SIZE}`
      + `&since=${encodeURIComponent(cutoffIso)}${participatingParam}`;
    let firstPage = true;
    let pollResponse: Response | null = null;
    const restartingIncompleteWindow = Boolean(this.notificationPollState.continuationUrl);
    this.pendingNotificationPollCompletion = null;

    await this.persistNotificationPollState({
      pendingSince: cutoffIso,
      continuationUrl: nextUrl,
    });

    try {
      while (nextUrl) {
        const headers: Record<string, string> = {};
        if (firstPage && !restartingIncompleteWindow && this.notificationPollState.etag) {
          headers['If-None-Match'] = this.notificationPollState.etag;
        }
        if (firstPage && !restartingIncompleteWindow && this.notificationPollState.lastModified) {
          headers['If-Modified-Since'] = this.notificationPollState.lastModified;
        }
        const res = await this.client!.restFetch(nextUrl, { headers });
        if (firstPage && res.status === 304) {
          this.stageNotificationPollCompletion(res, pollStartedAt);
          return [];
        }
        if (!res.ok) {
          await this.deferNotificationPoll(res);
          throw new Error(`Failed to fetch GitHub notifications: HTTP ${res.status}`);
        }

        if (firstPage) {
          pollResponse = res;
        }
        const batch = (await res.json()) as GitHubNotification[];
        for (const notification of batch) {
          const normalizedReason = notification.reason.toLowerCase();
          if (reasonFilter.size === 0 || reasonFilter.has(normalizedReason)) {
            notifications.set(notification.id, notification);
          }
        }

        nextUrl = this.parseLinkNext(res.headers.get('link'));
        await this.persistNotificationPollState({
          continuationUrl: nextUrl || undefined,
        });
        firstPage = false;
      }
    } catch (error) {
      await this.persistNotificationPollState({
        pendingSince: cutoffIso,
        continuationUrl: nextUrl || this.notificationPollState.continuationUrl,
      });
      throw error;
    }

    this.stageNotificationPollCompletion(pollResponse, pollStartedAt);
    return Array.from(notifications.values()).sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
    );
  }

  private stageNotificationPollCompletion(
    response: Response | null,
    checkpointSince: string,
  ): void {
    const interval = this.parsePositiveInteger(
      response?.headers.get('x-poll-interval') ?? null,
      this.notificationPollState.pollIntervalSeconds
        ?? DEFAULT_GITHUB_POLL_INTERVAL_SECONDS,
    );
    const jitteredInterval = Math.max(1, Math.round(interval * (0.9 + Math.random() * 0.2)));
    this.pendingNotificationPollCompletion = {
      checkpointSince,
      pollIntervalSeconds: interval,
      nextPollAt: new Date(Date.now() + jitteredInterval * 1_000).toISOString(),
      etag: response?.headers.get('etag') || this.notificationPollState.etag,
      lastModified: response?.headers.get('last-modified')
        || this.notificationPollState.lastModified,
    };
  }

  private async deferNotificationPoll(response: Response): Promise<void> {
    const retryAt = this.getGitHubRetryAt(response);
    if (!retryAt) return;
    const boundedRetryAt = new Date(Math.min(
      retryAt.getTime(),
      Date.now() + 24 * 60 * 60 * 1_000,
    ));
    await this.persistNotificationPollState({
      nextPollAt: boundedRetryAt.toISOString(),
    });
  }

  private getGitHubRetryAt(response: Response): Date | undefined {
    const retryAfter = this.parsePositiveInteger(response.headers.get('retry-after'), 0);
    if (retryAfter > 0) {
      return new Date(Date.now() + retryAfter * 1_000);
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetSeconds = this.parsePositiveInteger(
        response.headers.get('x-ratelimit-reset'),
        0,
      );
      if (resetSeconds > 0) return new Date(resetSeconds * 1_000);
    }
    return undefined;
  }

  private parsePositiveInteger(value: string | null, fallback: number): number {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async persistNotificationPollState(
    patch: Partial<GitHubNotificationPollState>,
  ): Promise<void> {
    if (!this.config) throw new Error('GitHub connector is not initialized');
    const transaction = sqlite.transaction(() => {
      const row = sqlite.prepare(
        'SELECT settings FROM connector_configs WHERE id = ?',
      ).get(this.id) as { settings: string | null } | undefined;
      if (!row) throw new Error(`GitHub connector ${this.id} no longer exists`);
      const latestSettings = row.settings ? JSON.parse(row.settings) as Record<string, unknown> : {};
      const nextState = {
        ...((latestSettings.notificationPollState || {}) as GitHubNotificationPollState),
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete nextState[key as keyof GitHubNotificationPollState];
        } else {
          Object.assign(nextState, { [key]: value });
        }
      }
      const settings = { ...latestSettings, notificationPollState: nextState };
      sqlite.prepare(`
        UPDATE connector_configs SET settings = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(settings), new Date().toISOString(), this.id);
      return { settings, nextState };
    });
    const { settings, nextState } = transaction.immediate();
    this.notificationPollState = nextState;
    this.config = { ...this.config, settings };
  }

  /** Extract the `next` URL from a GitHub Link header */
  private parseLinkNext(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) return null;
    // Return path only (strip origin so restFetch can prepend base)
    try {
      const url = new URL(match[1]);
      return url.pathname + url.search;
    } catch {
      return match[1];
    }
  }

  private mapGitHubLevel(reason: string): InboundNotification['level'] {
    switch (reason) {
      case 'security_alert': return 'urgent';
      case 'review_requested':
      case 'assign': return 'action_needed';
      case 'mention':
      case 'ci_activity': return 'heads_up';
      default: return 'fyi';
    }
  }

  private mapGitHubCategory(reason: string, subjectType: string): string {
    switch (reason) {
      case 'review_requested': return 'pr_review';
      case 'mention': return 'mention';
      case 'assign': return 'assignment';
      case 'ci_activity': return 'ci_cd';
      case 'security_alert': return 'security';
      default: return subjectType === 'Release' ? 'release' : 'github';
    }
  }

  private buildGitHubWebUrl(notification: GitHubNotification): string {
    const apiUrl = notification.subject.url;
    if (!apiUrl) return `https://github.com/${notification.repository.full_name}`;

    return apiUrl
      .replace('https://api.github.com/repos/', 'https://github.com/')
      .replace('/pulls/', '/pull/')
      .replace('/issues/', '/issues/');
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