/**
 * GitHub label CRUD operations — micro-status sync, priority sync, label creation.
 */

import { connectorLogger } from '@/lib/logger';
import { isMicroStatusTag, microStatusToTag, getMicroStatusTagColor } from '@/lib/micro-status';
import type { TaskPriority } from '@/types';
import type { GitHubClient } from './github-client';

/**
 * Sync micro-status to GitHub labels: removes existing mc:* labels, adds the new one.
 */
export async function syncMicroStatusLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  microStatus: string | null | undefined,
): Promise<void> {
  const labelsRes = await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  if (labelsRes.status === 404 || labelsRes.status === 410) return;
  if (!labelsRes.ok) {
    throw new Error(`Failed to fetch issue labels: ${labelsRes.status}`);
  }
  const currentLabels: Array<{ name: string }> = await labelsRes.json();
  const currentLabelNames = currentLabels.map(l => l.name);

  for (const labelName of currentLabelNames) {
    if (isMicroStatusTag(labelName)) {
      const removeRes = await client.restFetch(
        `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`,
        { method: 'DELETE' },
      );
      if (!removeRes.ok && removeRes.status !== 404) {
        throw new Error(`Failed to remove micro-status label "${labelName}": ${removeRes.status}`);
      }
    }
  }

  // Add new mc:* label if micro-status is set
  if (microStatus) {
    const newLabelName = microStatusToTag(microStatus);
    await ensureMicroStatusLabel(client, owner, repo, newLabelName);
    await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [newLabelName] }),
    });
  }
}

/** Ensure a mc:* label exists in the repo, creating it with the right color if needed */
export async function ensureMicroStatusLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  labelName: string,
): Promise<void> {
  const color = getMicroStatusTagColor(labelName) || '6e6e6e';
  const res = await client.restFetch(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: labelName,
      color,
      description: 'Mission Control micro-status',
    }),
  });
  // 422 = already exists, which is fine
  if (!res.ok && res.status !== 422) {
    connectorLogger.warn({ labelName, status: res.status }, 'Failed to create GitHub label');
  }
}

// ─── Priority Label Sync ────────────────────────────────────────────────────

/** Canonical label names MC writes back to GitHub */
const PRIORITY_LABEL_MAP: Record<Exclude<TaskPriority, 'none'>, { name: string; color: string }> = {
  critical: { name: 'priority:critical', color: 'b60205' },
  high:     { name: 'priority:high',     color: 'd93f0b' },
  medium:   { name: 'priority:medium',   color: 'eab308' },
  low:      { name: 'priority:low',      color: 'c2e0c6' },
};

/**
 * Detect whether a label's primary purpose is conveying priority.
 * Matches:
 *  - `priority:*`, `priority-*`, `priority/*`, `priority *` (any separator)
 *  - Standalone `P0`, `P1`, `P2`, `P3` (case-insensitive)
 * Does NOT match:
 *  - `type:bug` — that's a type label (the bug→high inference is a fallback)
 *  - Arbitrary labels that happen to contain a priority keyword
 */
export function isPriorityLabel(labelName: string): boolean {
  const lower = labelName.toLowerCase().trim();
  // Starts with "priority" followed by separator or end-of-string
  if (/^priority[\s:\/\-_]/.test(lower) || lower === 'priority') return true;
  // Standalone P0–P3
  if (/^p[0-3]$/i.test(lower)) return true;
  return false;
}

/**
 * Sync a priority value to GitHub labels: removes existing priority labels, adds the canonical one.
 * If priority is 'none', only removes — no label is added.
 */
export async function syncPriorityLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  priority: TaskPriority,
): Promise<void> {
  // Fetch current labels on this issue
  const labelsRes = await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  const currentLabels: Array<{ name: string }> = labelsRes.ok ? await labelsRes.json() : [];

  // Remove all existing priority labels
  for (const label of currentLabels) {
    if (isPriorityLabel(label.name)) {
      await client.restFetch(
        `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label.name)}`,
        { method: 'DELETE' },
      ).catch((err) => {
        connectorLogger.warn({ err, label: label.name, issue: issueNumber }, 'Best-effort priority label removal failed');
      });
    }
  }

  // Add the canonical label for the new priority (skip 'none')
  if (priority !== 'none') {
    const target = PRIORITY_LABEL_MAP[priority];
    await ensurePriorityLabel(client, owner, repo, target.name, target.color);
    await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [target.name] }),
    });
  }
}

/** Ensure a priority:* label exists in the repo, creating it with the right color if needed */
async function ensurePriorityLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  labelName: string,
  color: string,
): Promise<void> {
  await ensureLabel(client, owner, repo, labelName, color, 'Mission Control priority');
}

/**
 * Get the canonical priority label name for a given priority level.
 * Returns undefined for 'none'.
 */
export function priorityToLabelName(priority: TaskPriority): string | undefined {
  if (priority === 'none') return undefined;
  return PRIORITY_LABEL_MAP[priority]?.name;
}

/**
 * Ensure the canonical priority label for a level exists in a repo.
 * Safe to call repeatedly — no-ops if label already exists.
 */
export async function ensurePriorityLabelInRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  priority: Exclude<TaskPriority, 'none'>,
): Promise<void> {
  const target = PRIORITY_LABEL_MAP[priority];
  if (target) {
    await ensurePriorityLabel(client, owner, repo, target.name, target.color);
  }
}

// ─── Effort Label Sync ──────────────────────────────────────────────────────

/** Canonical effort labels: effort:1 through effort:5 */
const EFFORT_LABEL_MAP: Record<number, { name: string; color: string }> = {
  1: { name: 'effort:1', color: 'c2e0c6' },  // light green — trivial
  2: { name: 'effort:2', color: '7dc67d' },  // green — small
  3: { name: 'effort:3', color: 'eab308' },  // yellow — medium
  4: { name: 'effort:4', color: 'f97316' },  // orange — large
  5: { name: 'effort:5', color: 'd93f0b' },  // red-orange — epic
};

/**
 * Detect whether a label's primary purpose is conveying effort/size.
 * Matches patterns like: effort:xs, effort-s, size/m, t-shirt:l, effort:3
 */
export function isEffortLabel(labelName: string): boolean {
  const lower = labelName.toLowerCase().trim();
  return /^(?:effort|size|estimate|t-shirt)[\s:\/\-_]/.test(lower);
}

/**
 * Sync an effort value to GitHub labels: removes existing effort/size labels, adds the canonical one.
 * If effort is null/undefined, only removes — no label is added.
 */
export async function syncEffortLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  effort: number | null | undefined,
): Promise<void> {
  const labelsRes = await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  const currentLabels: Array<{ name: string }> = labelsRes.ok ? await labelsRes.json() : [];

  // Remove all existing effort/size labels
  for (const label of currentLabels) {
    if (isEffortLabel(label.name)) {
      await client.restFetch(
        `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label.name)}`,
        { method: 'DELETE' },
      ).catch((err) => {
        connectorLogger.warn({ err, label: label.name, issue: issueNumber }, 'Best-effort effort label removal failed');
      });
    }
  }

  // Add the canonical label for the new effort (skip null/undefined/0)
  if (effort && effort >= 1 && effort <= 5) {
    const target = EFFORT_LABEL_MAP[effort];
    await ensureLabel(client, owner, repo, target.name, target.color, 'Mission Control effort');
    await client.restFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [target.name] }),
    });
  }
}

/**
 * Get the canonical effort label name for a given effort level.
 */
export function effortToLabelName(effort: number | null | undefined): string | undefined {
  if (!effort || effort < 1 || effort > 5) return undefined;
  return EFFORT_LABEL_MAP[effort]?.name;
}

/**
 * Ensure the canonical effort label for a level exists in a repo.
 */
export async function ensureEffortLabelInRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  effort: number,
): Promise<void> {
  const target = EFFORT_LABEL_MAP[effort];
  if (target) {
    await ensureLabel(client, owner, repo, target.name, target.color, 'Mission Control effort');
  }
}

// ─── Label Normalization / Onboarding ───────────────────────────────────────

/** A non-canonical label detected during a scan, with its canonical replacement */
export interface LabelNormalization {
  /** Current label name on GitHub */
  current: string;
  /** Canonical replacement label name */
  canonical: string;
  /** Category: 'priority' or 'effort' */
  category: 'priority' | 'effort';
  /** Number of issues using this label */
  issueCount: number;
}

/**
 * Scan a repo's labels for non-canonical priority and effort labels.
 * Returns a list of normalizations needed (labels that should be renamed).
 */
export async function scanForNonCanonicalLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<LabelNormalization[]> {
  const normalizations: LabelNormalization[] = [];

  // Fetch all labels in the repo
  const allLabels: Array<{ name: string }> = [];
  let page = 1;
  while (true) {
    const res = await client.restFetch(`/repos/${owner}/${repo}/labels?per_page=100&page=${page}`);
    if (!res.ok) break;
    const batch: Array<{ name: string }> = await res.json();
    if (batch.length === 0) break;
    allLabels.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  const canonicalPriorityNames = new Set(Object.values(PRIORITY_LABEL_MAP).map(v => v.name.toLowerCase()));
  const canonicalEffortNames = new Set(Object.values(EFFORT_LABEL_MAP).map(v => v.name.toLowerCase()));

  for (const label of allLabels) {
    const lower = label.name.toLowerCase().trim();

    // Skip already-canonical labels
    if (canonicalPriorityNames.has(lower) || canonicalEffortNames.has(lower)) continue;

    // Check if it's a non-canonical priority label
    if (isPriorityLabel(label.name)) {
      const canonical = mapNonCanonicalPriority(label.name);
      if (canonical) {
        const count = await getLabelIssueCount(client, owner, repo, label.name);
        normalizations.push({
          current: label.name,
          canonical,
          category: 'priority',
          issueCount: count,
        });
      }
    }

    // Check if it's a non-canonical effort label
    if (isEffortLabel(label.name)) {
      const canonical = mapNonCanonicalEffort(label.name);
      if (canonical) {
        const count = await getLabelIssueCount(client, owner, repo, label.name);
        normalizations.push({
          current: label.name,
          canonical,
          category: 'effort',
          issueCount: count,
        });
      }
    }
  }

  return normalizations;
}

/**
 * Normalize labels on a repo: for each normalization, re-label all issues
 * from the old label to the canonical one, then delete the old label.
 */
export async function normalizeLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
  normalizations: LabelNormalization[],
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const norm of normalizations) {
    try {
      // Ensure the canonical label exists
      if (norm.category === 'priority') {
        const target = Object.values(PRIORITY_LABEL_MAP).find(v => v.name === norm.canonical);
        if (target) await ensureLabel(client, owner, repo, target.name, target.color, 'Mission Control priority');
      } else {
        const target = Object.values(EFFORT_LABEL_MAP).find(v => v.name === norm.canonical);
        if (target) await ensureLabel(client, owner, repo, target.name, target.color, 'Mission Control effort');
      }

      // Find all issues with the old label and re-label them
      let page = 1;
      let issuesMigrated = 0;
      let issuesFailed = 0;
      while (true) {
        const searchRes = await client.restFetch(
          `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(norm.current)}&state=all&per_page=100&page=${page}`,
        );
        if (!searchRes.ok) break;
        const issues: Array<{ number: number }> = await searchRes.json();
        if (issues.length === 0) break;

        for (const issue of issues) {
          // Add canonical label first — only remove old if add succeeded
          const addRes = await client.restFetch(`/repos/${owner}/${repo}/issues/${issue.number}/labels`, {
            method: 'POST',
            body: JSON.stringify({ labels: [norm.canonical] }),
          }).catch(() => null);

          if (addRes && addRes.ok) {
            // Safe to remove old label now
            await client.restFetch(
              `/repos/${owner}/${repo}/issues/${issue.number}/labels/${encodeURIComponent(norm.current)}`,
              { method: 'DELETE' },
            ).catch(() => { /* old label stays — not harmful */ });
            issuesMigrated++;
          } else {
            issuesFailed++;
          }
        }

        if (issues.length < 100) break;
        page++;
      }

      // Only delete the old repo label if ALL issues were migrated
      if (issuesFailed === 0) {
        await client.restFetch(
          `/repos/${owner}/${repo}/labels/${encodeURIComponent(norm.current)}`,
          { method: 'DELETE' },
        ).catch(() => { /* best effort */ });
      }

      if (issuesFailed > 0) {
        errors.push(`"${norm.current}": ${issuesMigrated} migrated, ${issuesFailed} failed (old label kept)`);
      }
      succeeded++;
    } catch (err) {
      failed++;
      errors.push(`Failed to normalize "${norm.current}" → "${norm.canonical}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { succeeded, failed, errors };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Map a non-canonical priority label to its canonical form */
function mapNonCanonicalPriority(labelName: string): string | null {
  const lower = labelName.toLowerCase().trim();
  // Extract the suffix after the separator (e.g., "priority:high" → "high", "P1" → "p1")
  const suffixMatch = lower.match(/^priority[\s:\/\-_]+(.+)$/);
  const suffix = suffixMatch ? suffixMatch[1].trim() : lower;

  // Match suffix against known keywords (exact match on suffix avoids ambiguity)
  const priorityKeywords: Record<string, keyof typeof PRIORITY_LABEL_MAP> = {
    critical: 'critical', p0: 'critical', urgent: 'critical',
    high: 'high', p1: 'high',
    medium: 'medium', p2: 'medium', default: 'medium',
    low: 'low', p3: 'low',
  };

  const mapped = priorityKeywords[suffix];
  if (mapped) return PRIORITY_LABEL_MAP[mapped].name;
  return null;
}

/** Map a non-canonical effort label to its canonical form */
function mapNonCanonicalEffort(labelName: string): string | null {
  const lower = labelName.toLowerCase().trim();
  const match = lower.match(/(?:effort|size|estimate|t-shirt)[:/\-_\s]+([\w-]+)/);
  if (!match) return null;

  const effortMap: Record<string, number> = {
    xs: 1, 'extra-small': 1, 'extra small': 1, trivial: 1,
    s: 2, small: 2, easy: 2,
    m: 3, medium: 3, moderate: 3,
    l: 4, large: 4, hard: 4,
    xl: 5, 'extra-large': 5, 'extra large': 5, epic: 5,
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  };

  const value = effortMap[match[1]];
  if (value && EFFORT_LABEL_MAP[value]) return EFFORT_LABEL_MAP[value].name;
  return null;
}

/** Get the count of issues using a specific label */
async function getLabelIssueCount(
  client: GitHubClient,
  owner: string,
  repo: string,
  labelName: string,
): Promise<number> {
  const res = await client.restFetch(
    `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(labelName)}&state=all&per_page=1`,
  );
  if (!res.ok) return 0;
  // GitHub returns total count in the Link header or we count items
  const items = await res.json();
  // Parse the Link header for total pages, or just return a rough count
  const linkHeader = res.headers.get('link') || '';
  const lastPageMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
  if (lastPageMatch) return parseInt(lastPageMatch[1], 10);
  return Array.isArray(items) ? items.length : 0;
}

/** Generic label-ensure helper (shared by priority + effort) */
async function ensureLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  labelName: string,
  color: string,
  description: string,
): Promise<void> {
  const res = await client.restFetch(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: labelName, color, description }),
  });
  if (!res.ok && res.status !== 422) {
    connectorLogger.warn({ labelName, status: res.status }, 'Failed to create label');
  }
}

/** Create a label on a GitHub repo. */
export async function createLabelInRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  tagName: string,
  color?: string,
): Promise<void> {
  const labelColor = color ? color.replace(/^#/, '') : '6b7280';
  const res = await client.restFetch(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: tagName,
      color: labelColor,
      description: 'Created from Mission Control',
    }),
  });
  if (!res.ok && res.status !== 422) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to create label "${tagName}" on ${owner}/${repo}: ${res.status} ${body}`);
  }
}
