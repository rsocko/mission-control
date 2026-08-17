/**
 * GitHub Stars importer for triage queue.
 */
import { ingestTriageImport } from '../capture';
import { fetchWithRateLimit, IMPORT_USER_AGENT, MAX_PAGES } from './base-importer';
import { upsertSyncState } from '../sync-state';
import type { TriageImportSummary, FullSyncResult } from './base-importer';

function parseGitHubNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    return url.searchParams.get('page');
  } catch {
    return null;
  }
}

interface GitHubStarRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
  owner?: { login?: string; avatar_url?: string };
  fork?: boolean;
}

interface GitHubStarWithTimestamp {
  starred_at?: string;
  repo?: GitHubStarRepo;
}

export async function importGitHubStars(input: {
  token: string;
  username?: string;
  perPage?: number;
  page?: number;
}): Promise<TriageImportSummary> {
  const perPage = Math.min(Math.max(input.perPage ?? 50, 1), 100);
  const page = Math.max(input.page ?? 1, 1);
  const endpoint = input.username ? `/users/${input.username}/starred` : '/user/starred';
  const url = new URL(`https://api.github.com${endpoint}`);
  url.searchParams.set('sort', 'created');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));

  const response = await fetchWithRateLimit(url, {
    headers: {
      Authorization: `${'Bearer'} ${input.token}`,
      Accept: 'application/vnd.github.star+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': IMPORT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub stars import failed: ${response.status} ${response.statusText}`);
  }

  const rows = (await response.json()) as Array<GitHubStarRepo | GitHubStarWithTimestamp>;
  const summary: TriageImportSummary = {
    imported: 0,
    skipped: 0,
    errors: [],
    nextCursor: parseGitHubNextCursor(response.headers.get('link')),
  };

  for (const row of rows) {
    const withTimestamp = row as GitHubStarWithTimestamp;
    const repo = withTimestamp.repo || (row as GitHubStarRepo);
    if (!repo?.full_name || !repo.html_url) {
      summary.skipped += 1;
      summary.errors.push('Skipped GitHub row missing full_name/html_url');
      continue;
    }

    const result = await ingestTriageImport({
      sourcePlatform: 'github',
      sourceId: `github:star:${repo.full_name.toLowerCase()}`,
      sourceUrl: repo.html_url,
      canonicalUrl: repo.html_url,
      title: repo.full_name,
      description: repo.description || undefined,
      thumbnailUrl: repo.owner?.avatar_url || `https://opengraph.githubassets.com/1/${repo.full_name}`,
      capturedAt: withTimestamp.starred_at,
      rawMetadata: {
        fullName: repo.full_name,
        language: repo.language,
        topics: repo.topics || [],
        stargazersCount: repo.stargazers_count,
        ownerLogin: repo.owner?.login || null,
        fork: !!repo.fork,
        starredAt: withTimestamp.starred_at || null,
      },
    });

    if (result.status === 'imported') {
      summary.imported += 1;
    } else {
      summary.skipped += 1;
    }
  }

  return summary;
}

export async function importAllGitHubStars(input: {
  token: string;
  username?: string;
  incremental?: boolean;
}): Promise<FullSyncResult> {
  const startTime = Date.now();
  const result: FullSyncResult = { imported: 0, skipped: 0, errors: [], pagesProcessed: 0, durationMs: 0, lastCursor: null };

  let page = 1;
  const CONSECUTIVE_SKIP_THRESHOLD = 20;
  let consecutiveSkips = 0;

  while (page <= MAX_PAGES) {
    const summary = await importGitHubStars({
      token: input.token,
      username: input.username,
      perPage: 100,
      page,
    });

    result.pagesProcessed += 1;
    result.imported += summary.imported;
    result.skipped += summary.skipped;
    result.errors.push(...summary.errors);

    if (input.incremental && summary.imported === 0) {
      consecutiveSkips += summary.skipped;
      if (consecutiveSkips >= CONSECUTIVE_SKIP_THRESHOLD) break;
    } else {
      consecutiveSkips = 0;
    }

    if (!summary.nextCursor) break;
    result.lastCursor = summary.nextCursor;
    page = Number(summary.nextCursor);
  }

  result.durationMs = Date.now() - startTime;

  await upsertSyncState('github-stars', {
    lastCursor: result.lastCursor,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    durationMs: result.durationMs,
  });

  return result;
}
