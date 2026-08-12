import { resolveGitHubCredentials } from '../credentials';
import { buildActionTitle } from './build-task-title';
import logger from '@/lib/logger';
import type { TriageItem, TriageActionRecord } from '@/types';

export interface CreateGitHubIssueOptions {
  repo?: string;
  title?: string;
  body?: string;
  labels?: string[];
}

export interface CreateGitHubIssueResult {
  issueNumber: number;
  issueUrl: string;
  repo: string;
}

/**
 * Extract owner/repo from a GitHub URL.
 * Handles: github.com/owner/repo, github.com/owner/repo/...
 */
function extractRepoFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('github.com')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    // not a valid URL
  }
  return null;
}

function resolveRepo(item: TriageItem, override?: string): string | null {
  if (override) return override;

  // Try to extract from the triage item's source URL
  const fromSource = extractRepoFromUrl(item.sourceUrl);
  if (fromSource) return fromSource;

  if (item.canonicalUrl) {
    const fromCanonical = extractRepoFromUrl(item.canonicalUrl);
    if (fromCanonical) return fromCanonical;
  }

  // Fall back to configurable default
  return process.env.MC_GITHUB_DEFAULT_REPO || null;
}

function buildIssueTitle(item: TriageItem): string {
  return buildActionTitle(item);
}

function buildIssueBody(item: TriageItem): string {
  const lines: string[] = [];

  if (item.aiSummary) {
    lines.push(item.aiSummary, '');
  } else if (item.description) {
    lines.push(item.description, '');
  }

  lines.push('---', '');
  lines.push(`**Source:** [${item.sourceUrl}](${item.sourceUrl})`);
  lines.push(`**Platform:** ${item.sourcePlatform}`);
  lines.push(`**Captured:** ${item.capturedAt}`);

  if (item.contentType) {
    lines.push(`**Content type:** ${item.contentType}`);
  }

  lines.push('', '*Created from Mission Control triage queue*');

  return lines.join('\n');
}

export async function createGitHubIssue(
  item: TriageItem,
  options: CreateGitHubIssueOptions = {},
): Promise<CreateGitHubIssueResult> {
  const credentials = await resolveGitHubCredentials();
  if (!credentials) {
    throw new Error(
      'No GitHub credentials found. Set GITHUB_PAT env var or configure credentials in triage settings.',
    );
  }

  const repo = resolveRepo(item, options.repo);
  if (!repo) {
    throw new Error(
      'Could not determine target repo. Provide a repo override or set MC_GITHUB_DEFAULT_REPO.',
    );
  }

  const title = options.title || buildIssueTitle(item);
  const body = options.body || buildIssueBody(item);

  const labels = options.labels?.length
    ? options.labels
    : ['triage', `source:${item.sourcePlatform}`];
  const payload: Record<string, unknown> = { title, body, labels };

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error(
      { status: response.status, body: errorBody, repo },
      'GitHub issue creation failed',
    );
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as { number: number; html_url: string };

  logger.info(
    { repo, issueNumber: data.number, issueUrl: data.html_url },
    'Created GitHub issue from triage',
  );

  return {
    issueNumber: data.number,
    issueUrl: data.html_url,
    repo,
  };
}

/**
 * Build a TriageActionRecord that includes issue creation result metadata.
 */
export function buildGitHubIssueActionRecord(
  result: CreateGitHubIssueResult,
): TriageActionRecord {
  return {
    actionType: 'create_task_github',
    appliedAt: new Date().toISOString(),
    note: `Created issue #${result.issueNumber} in ${result.repo}: ${result.issueUrl}`,
  };
}
