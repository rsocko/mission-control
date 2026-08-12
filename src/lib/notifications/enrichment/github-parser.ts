/**
 * GitHub Notification Parser
 *
 * Transforms raw GitHub notification data into human-friendly titles,
 * structured bodies, and rich presentation metadata. Extracts entity
 * references (PR numbers, issue numbers, repos) from API URLs.
 */

import type { InboundNotification } from '@/types';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface ParsedNotification {
  title: string;
  body: string;
  templateKey: string;
  category: string;
  presentation: GitHubPresentation;
  /** Extracted issue/PR number if available */
  entityNumber?: number;
  /** Extracted repo full name */
  repository?: string;
}

export interface GitHubPresentation {
  subjectType: 'PullRequest' | 'Issue' | 'Release' | 'Discussion' | 'Commit' | 'CheckSuite' | string;
  reason: string;
  reasonLabel: string;
  repository: string;
  entityNumber?: number;
  entityUrl?: string;
  /** Human-friendly subtitle combining repo + number */
  subtitle: string;
}

export function buildGitHubActionLabel(
  presentation: Pick<GitHubPresentation, 'subjectType' | 'reason'>,
): string {
  if (presentation.reason === 'review_requested') return 'Review PR';
  if (presentation.reason === 'security_alert') return 'View alert';
  if (presentation.subjectType === 'PullRequest') return 'Open PR';
  if (presentation.subjectType === 'Issue') return 'Open issue';
  if (presentation.subjectType === 'Release') return 'View release';
  if (presentation.subjectType === 'Discussion') return 'Open discussion';
  return 'Open in GitHub';
}

// ─── REASON → HUMAN LABEL MAP ───────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  review_requested: 'Review Requested',
  assign: 'Assigned to You',
  mention: 'You Were Mentioned',
  comment: 'New Comment',
  state_change: 'State Changed',
  ci_activity: 'CI Activity',
  security_alert: 'Security Alert',
  subscribed: 'Subscribed',
  team_mention: 'Team Mentioned',
  author: 'You Authored',
  approval_requested: 'Approval Requested',
  manual: 'Manual',
};

// ─── SUBJECT TYPE → TITLE PREFIX MAP ────────────────────────────────────────

const SUBJECT_PREFIX: Record<string, string> = {
  PullRequest: 'PR',
  Issue: 'Issue',
  Release: 'Release',
  Discussion: 'Discussion',
  Commit: 'Commit',
  CheckSuite: 'CI',
  RepositoryVulnerabilityAlert: 'Security',
};

// ─── REASON → TEMPLATE KEY MAP ──────────────────────────────────────────────

function resolveTemplateKey(reason: string, subjectType: string): string {
  switch (reason) {
    case 'review_requested': return 'pr_review_requested';
    case 'security_alert': return 'security_alert';
    case 'ci_activity': return 'ci_failure';
    case 'assign':
      return subjectType === 'PullRequest' ? 'pr_assigned' : 'issue_assigned';
    case 'mention':
      return 'mention';
    default:
      return subjectType === 'PullRequest' ? 'pr_activity' : 'github_activity';
  }
}

// ─── REASON → CATEGORY MAP ─────────────────────────────────────────────────

function resolveCategory(reason: string, subjectType: string): string {
  switch (reason) {
    case 'review_requested': return 'social';
    case 'mention':
    case 'team_mention': return 'social';
    case 'security_alert': return 'security';
    case 'ci_activity': return 'system';
    case 'assign': return 'tasks';
    default:
      return subjectType === 'Release' ? 'system' : 'social';
  }
}

// ─── ENTITY NUMBER EXTRACTION ───────────────────────────────────────────────

/**
 * Extracts issue/PR number from a GitHub API URL like:
 * https://api.github.com/repos/owner/repo/pulls/142
 * https://api.github.com/repos/owner/repo/issues/99
 */
function extractEntityNumber(subjectUrl?: string | null): number | undefined {
  if (!subjectUrl) return undefined;
  const match = subjectUrl.match(/\/(pulls|issues|releases|commits)\/(\d+)$/);
  return match ? parseInt(match[2], 10) : undefined;
}

/**
 * Builds a web URL from a GitHub API URL.
 */
function buildWebUrl(subjectUrl?: string | null, repository?: string): string | undefined {
  if (!subjectUrl) return repository ? `https://github.com/${repository}` : undefined;
  return subjectUrl
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace('/pulls/', '/pull/');
}

// ─── MAIN PARSER ────────────────────────────────────────────────────────────

/**
 * Parses a raw GitHub notification (as returned by fetchNotifications) into
 * a human-friendly structure with rich presentation metadata.
 */
export function parseGitHubNotification(notification: InboundNotification): ParsedNotification {
  const metadata = notification.metadata as {
    reason?: string;
    subjectType?: string;
    subjectUrl?: string | null;
    repository?: string;
    notificationId?: string;
  };

  const reason = metadata.reason || 'subscribed';
  const subjectType = metadata.subjectType || 'Issue';
  const subjectUrl = metadata.subjectUrl || null;
  const repository = metadata.repository || '';

  const entityNumber = extractEntityNumber(subjectUrl);
  const entityUrl = buildWebUrl(subjectUrl, repository);
  const reasonLabel = REASON_LABELS[reason] || reason.replace(/_/g, ' ');
  const subjectPrefix = SUBJECT_PREFIX[subjectType] || subjectType;

  // Build human-friendly title: "PR Review Requested: Fix auth middleware"
  const isRawConnectorTitle = /^\[.*?\]\s*/.test(notification.title);
  const rawSubjectTitle = extractSubjectTitle(notification.title);
  const title = isRawConnectorTitle
    ? buildHumanTitle(reason, subjectPrefix, rawSubjectTitle)
    : notification.title;

  // Build structured body: "octo-org/api-gateway #142"
  const subtitle = buildSubtitle(repository, entityNumber);
  const body = buildHumanBody(reasonLabel, subtitle);

  const templateKey = resolveTemplateKey(reason, subjectType);
  const category = resolveCategory(reason, subjectType);

  return {
    title,
    body,
    templateKey,
    category,
    presentation: {
      subjectType,
      reason,
      reasonLabel,
      repository,
      entityNumber,
      entityUrl,
      subtitle,
    },
    entityNumber,
    repository,
  };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Strips the raw `[Type]` prefix from the connector's title.
 * Input: "[PullRequest] Fix auth middleware"
 * Output: "Fix auth middleware"
 */
function extractSubjectTitle(rawTitle: string): string {
  return rawTitle.replace(/^\[.*?\]\s*/, '');
}

/**
 * Builds a human-friendly title combining reason + subject.
 * Examples:
 *   "PR Review Requested: Fix auth middleware"
 *   "Issue Assigned: Add WebSocket support"
 *   "Security Alert: Dependency vulnerability"
 */
function buildHumanTitle(reason: string, subjectPrefix: string, subjectTitle: string): string {
  switch (reason) {
    case 'review_requested':
      return `${subjectPrefix} Review Requested: ${subjectTitle}`;
    case 'assign':
      return `${subjectPrefix} Assigned: ${subjectTitle}`;
    case 'mention':
      return `Mentioned in ${subjectPrefix}: ${subjectTitle}`;
    case 'comment':
      return `New Comment on ${subjectPrefix}: ${subjectTitle}`;
    case 'state_change':
      return `${subjectPrefix} Updated: ${subjectTitle}`;
    case 'ci_activity':
      return `CI ${subjectPrefix}: ${subjectTitle}`;
    case 'security_alert':
      return `Security Alert: ${subjectTitle}`;
    case 'team_mention':
      return `Team Mentioned in ${subjectPrefix}: ${subjectTitle}`;
    case 'author':
      return `${subjectPrefix} Activity: ${subjectTitle}`;
    default:
      return `${subjectPrefix}: ${subjectTitle}`;
  }
}

/**
 * Builds a subtitle like "octo-org/api-gateway #142" or "octo-org/api-gateway"
 */
function buildSubtitle(repository: string, entityNumber?: number): string {
  if (entityNumber) {
    return `${repository} #${entityNumber}`;
  }
  return repository;
}

/**
 * Builds the notification body combining reason label and subtitle.
 * Example: "Review Requested · octo-org/api-gateway #142"
 */
function buildHumanBody(reasonLabel: string, subtitle: string): string {
  return `${reasonLabel} · ${subtitle}`;
}

// ─── BATCH HELPER ───────────────────────────────────────────────────────────

/**
 * Checks whether an InboundNotification is from the GitHub connector and has
 * the metadata structure we expect to parse.
 */
export function isGitHubNotification(notification: InboundNotification): boolean {
  return notification.connectorType === 'github-issues' &&
    notification.metadata != null &&
    typeof (notification.metadata as Record<string, unknown>).reason === 'string';
}
