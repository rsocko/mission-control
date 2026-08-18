import type { InboundNotification } from '@/types';
import type { AlertReconciliation } from '../index';
import {
  ConnectorWritebackError,
  type NotificationWritebackAction,
} from '../notification-writeback-contract';
import type { GitHubClient, GitHubNotification } from './github-client';

export interface GitHubNotificationPollState {
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

export interface GitHubNotificationsSettings {
  fetchNotificationsEnabled: boolean;
  notificationReasons: string[];
  participatingOnly: boolean;
  authenticatedUser: string;
  notificationPollState: GitHubNotificationPollState;
}

/** Everything the notifications adapter needs from the owning connector instance. */
export interface GitHubNotificationsAdapterDeps {
  connectorType: string;
  getConnectorId: () => string;
  getClient: () => GitHubClient;
  /**
   * Persists a merge-patch of the notification poll checkpoint through the
   * shared connector config store and returns the resulting state. Injected
   * so this adapter never touches `@/db` / `@/db/schema` directly.
   */
  persistPollState: (
    patch: Partial<GitHubNotificationPollState>,
  ) => Promise<GitHubNotificationPollState>;
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

/**
 * Fetches, maps, and writes back GitHub notifications (the `/notifications`
 * REST feed), including incremental polling checkpoints (ETag/If-Modified-Since,
 * Link-header pagination, and provider-directed retry backoff) and per-alert
 * reconciliation against upstream PR/issue state.
 *
 * Owns the notification-poll state that used to live directly on
 * `GitHubIssuesConnector`, so it can be constructed and exercised
 * independently of issue CRUD or Projects V2 sync concerns.
 */
export class GitHubNotificationsAdapter {
  private fetchNotificationsEnabled = true;
  private notificationReasons: string[] = [];
  private participatingOnly = false;
  private authenticatedUser = '';
  private notificationPollState: GitHubNotificationPollState = {};
  private pendingNotificationPollCompletion: GitHubNotificationPollCompletion | null = null;

  constructor(private readonly deps: GitHubNotificationsAdapterDeps) {}

  /** Applies discovered connector settings. Call from the connector's initialize(). */
  configure(settings: GitHubNotificationsSettings): void {
    this.fetchNotificationsEnabled = settings.fetchNotificationsEnabled;
    this.notificationReasons = settings.notificationReasons;
    this.participatingOnly = settings.participatingOnly;
    this.authenticatedUser = settings.authenticatedUser;
    this.notificationPollState = settings.notificationPollState;
  }

  /**
   * Partial reset mirroring the pre-extraction connector's dispose(): note
   * that `authenticatedUser` and any pending poll completion are
   * intentionally left untouched, matching the original behavior exactly.
   */
  resetForDispose(): void {
    this.fetchNotificationsEnabled = true;
    this.notificationReasons = [];
    this.participatingOnly = false;
    this.notificationPollState = {};
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    if (!this.fetchNotificationsEnabled) {
      return [];
    }

    const cutoff = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const notifications = await this.fetchGitHubNotifications(cutoff);

    return notifications.map((notification) => ({
      id: `gh-notif-${notification.id}`,
      sourceId: notification.id,
      connectorType: this.deps.connectorType,
      connectorInstanceId: this.deps.getConnectorId(),
      title: `[${notification.subject.type}] ${notification.subject.title}`,
      body: `${notification.reason} in ${notification.repository.full_name}`,
      level: this.mapGitHubLevel(notification.reason),
      category: 'development',
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
    const res = await this.deps.getClient().restFetch(path, request);
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
  async reconcileAlerts(activeSourceIds: string[]): Promise<AlertReconciliation[]> {
    const results: AlertReconciliation[] = [];
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
  private async reconcileSingleAlert(sourceId: string): Promise<AlertReconciliation | null> {
      // Extract the GitHub notification thread ID
      const match = sourceId.match(/^[^:]*:gh-notif-(.+)$/);
      if (!match) return null;

      const threadId = match[1];
      try {
        const res = await this.deps.getClient().restFetch(`/notifications/threads/${threadId}`);
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
          const prRes = await this.deps.getClient().restFetch(prPath);
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
          const issueRes = await this.deps.getClient().restFetch(thread.subject.url.replace('https://api.github.com', ''));
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
        const res = await this.deps.getClient().restFetch(nextUrl, { headers });
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
    this.notificationPollState = await this.deps.persistPollState(patch);
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

  private buildGitHubWebUrl(notification: GitHubNotification): string {
    const apiUrl = notification.subject.url;
    if (!apiUrl) return `https://github.com/${notification.repository.full_name}`;

    return apiUrl
      .replace('https://api.github.com/repos/', 'https://github.com/')
      .replace('/pulls/', '/pull/')
      .replace('/issues/', '/issues/');
  }
}
