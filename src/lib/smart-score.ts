/**
 * Smart Score Engine
 *
 * Computes a composite 0–100 score for each task by combining:
 *   - Priority baseline (up to 20 pts)
 *   - Entity tier relevance (up to 30 pts)
 *   - Urgency / due-date pressure (up to 25 pts)
 *   - Source trust rank (up to 12 pts)
 *   - Freshness / recency (up to 13 pts)
 *
 * The score powers the "Sort by Smart Score" view and AI triage recommendations.
 */

import type { TaskPriority } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EntityTier = 'critical' | 'high' | 'medium' | 'standard';
export type PriorityEntityType = 'person' | 'project' | 'tag' | 'source' | 'team' | 'domain';

export interface PriorityEntity {
  id: string;
  name: string;
  type: PriorityEntityType;
  referenceId?: string | null;
  referenceStatus?: 'resolved' | 'missing';
  description?: string;
  tier: EntityTier;
  color: string;
  rank: number;
  activeTaskCount: number;
  lastTouchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRanking {
  id: string;
  connectorType: string;
  name: string;
  rank: number;
  updatedAt: string;
}

export interface ScoreInput {
  taskId: string;
  title: string;
  priority: TaskPriority;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  connectorType: string;
  connectorInstanceId: string;
  /** Entity names associated with this task (from tags, project names, assignee, etc.) */
  linkedEntityNames: string[];
  /** Free-text task content used to find work for or about a configured person. */
  personText: string[];
  /** Canonical entity references associated with this task. */
  linkedEntityRefs: Array<{ type: 'project' | 'tag' | 'source'; id: string }>;
  /** ISO timestamp when the task is snoozed until (applies a score penalty while active) */
  snoozedUntil?: string | null;
  /** Effort level 1–5 (optional). Low effort boosts score as a quick-win signal. */
  effort?: number | null;
}

export interface ScoreInputTask {
  id: string;
  title: string;
  description?: string | null;
  priority: TaskPriority;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListName?: string | null;
  sourceListId?: string | null;
  assignee?: string | null;
  snoozedUntil?: string | null;
  effort?: number | null;
}

export interface ScoreBreakdown {
  priorityBase: number; // 0–20
  entityTier: number;   // 0–30
  urgency: number;      // 0–25
  sourceRank: number;   // 0–12
  freshness: number;    // 0–13
  effortBonus: number;  // 0–5 (quick-win bonus for low effort)
  snoozePenalty: number; // 0 to -15 (penalty applied when task is snoozed)
  total: number;        // 0–100
}

export interface ScoredTask {
  taskId: string;
  score: ScoreBreakdown;
  matchedEntities: Array<{ name: string; tier: EntityTier; rank: number }>;
}

// ─── Scoring Weights ────────────────────────────────────────────────────────

const TIER_POINTS: Record<EntityTier, number> = {
  critical: 30,
  high: 21,
  medium: 12,
  standard: 3,
};

/** Baseline points awarded purely from the task's priority level (0–20). */
const PRIORITY_BASE_POINTS: Record<TaskPriority, number> = {
  critical: 20,
  high: 15,
  medium: 8,
  low: 3,
  none: 0,
};

const PRIORITY_URGENCY_BONUS: Record<TaskPriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
  none: 0,
};

/** Quick-win bonus for low-effort tasks (0–5 pts). Lower effort = higher bonus. */
const EFFORT_BONUS: Record<number, number> = {
  1: 5,   // XS — easiest quick win
  2: 3,   // S
  3: 1,   // M
  4: 0,   // L
  5: -2,  // XL — slight penalty (heavy lift)
};

function containsDelimitedName(text: string, name: string): boolean {
  const isWordCharacter = (character: string) => /[a-z0-9]/.test(character);
  let start = text.indexOf(name);
  while (start !== -1) {
    const before = start === 0 ? '' : text[start - 1];
    const afterIndex = start + name.length;
    const after = afterIndex >= text.length ? '' : text[afterIndex];
    if ((!before || !isWordCharacter(before)) && (!after || !isWordCharacter(after))) {
      return true;
    }
    start = text.indexOf(name, start + 1);
  }
  return false;
}

// ─── Core Scoring ───────────────────────────────────────────────────────────

/**
 * Compute the entity-tier component (0–30).
 * Uses the best-matched entity tier for this task.
 */
function computeEntityScore(
  linkedNames: string[],
  personText: string[],
  linkedRefs: ScoreInput['linkedEntityRefs'],
  entities: PriorityEntity[],
): { score: number; matched: Array<{ name: string; tier: EntityTier; rank: number }> } {
  if (
    entities.length === 0
    || (linkedNames.length === 0 && personText.length === 0 && linkedRefs.length === 0)
  ) {
    return { score: 0, matched: [] };
  }

  const matched: Array<{ name: string; tier: EntityTier; rank: number }> = [];
  let bestScore = 0;

  const normalizedNames = linkedNames.map((n) => n.toLowerCase().trim());
  const normalizedPersonText = personText.map((text) => text.toLowerCase().trim());

  for (const entity of entities) {
    const entityNameLower = entity.name.toLowerCase().trim();
    const hasCanonicalReference = Boolean(
      entity.referenceId
      && (entity.type === 'project' || entity.type === 'tag' || entity.type === 'source'),
    );
    const namesToSearch = entity.type === 'person' ? normalizedPersonText : normalizedNames;
    const matched_ = hasCanonicalReference
      ? linkedRefs.some((ref) => ref.type === entity.type && ref.id === entity.referenceId)
      : entity.type === 'person'
        ? namesToSearch.some((text) => containsDelimitedName(text, entityNameLower))
        : entityNameLower.length < 3
          ? namesToSearch.some((n) => n === entityNameLower)
          : namesToSearch.some((n) => n === entityNameLower || n.includes(entityNameLower) || entityNameLower.includes(n));

    if (matched_) {
      const tierScore = TIER_POINTS[entity.tier];
      // Apply a small rank bonus within tier (higher rank = slightly more points)
      const rankBonus = Math.max(0, (20 - entity.rank) * 0.3);
      const entityScore = Math.min(30, tierScore + rankBonus);

      matched.push({ name: entity.name, tier: entity.tier, rank: entity.rank });
      bestScore = Math.max(bestScore, entityScore);
    }
  }

  return { score: Math.round(bestScore), matched };
}

/**
 * Compute the priority baseline (0–20).
 * Ensures higher-priority tasks get a significant score floor.
 */
function computePriorityBase(priority: TaskPriority): number {
  return PRIORITY_BASE_POINTS[priority] ?? 0;
}

/**
 * Compute the urgency component (0–25).
 * Combines due-date pressure with a small priority bonus.
 */
function computeUrgencyScore(dueDate: string | null | undefined, priority: TaskPriority): number {
  let duePressure = 0;

  if (dueDate) {
    const now = new Date();
    const due = new Date(dueDate);
    const daysUntilDue = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysUntilDue < 0) {
      // Overdue — max urgency
      duePressure = 17;
    } else if (daysUntilDue <= 1) {
      duePressure = 15;
    } else if (daysUntilDue <= 3) {
      duePressure = 12;
    } else if (daysUntilDue <= 7) {
      duePressure = 8;
    } else if (daysUntilDue <= 14) {
      duePressure = 5;
    } else {
      duePressure = 2;
    }
  }

  const priorityBonus = PRIORITY_URGENCY_BONUS[priority] ?? 0;
  return Math.min(25, duePressure + priorityBonus);
}

/**
 * Compute the source rank component (0–12).
 * Higher-ranked sources produce higher scores.
 */
function computeSourceScore(connectorInstanceId: string, sourceRankings: SourceRanking[]): number {
  if (sourceRankings.length === 0) return 6; // Default mid-score when no rankings configured

  const ranking = sourceRankings.find((r) => r.id === connectorInstanceId);
  if (!ranking) return 4;

  const totalSources = sourceRankings.length;
  // Rank 1 = 12 pts, last rank = 2 pts
  const normalized = Math.max(0, 1 - (ranking.rank - 1) / Math.max(1, totalSources - 1));
  return Math.round(2 + normalized * 10);
}

/**
 * Compute the freshness component (0–13).
 * Recently updated tasks get a freshness boost.
 */
function computeFreshnessScore(updatedAt: string): number {
  const now = new Date();
  const updated = new Date(updatedAt);
  const hoursAgo = (now.getTime() - updated.getTime()) / (1000 * 60 * 60);

  if (hoursAgo <= 2) return 13;
  if (hoursAgo <= 6) return 10;
  if (hoursAgo <= 24) return 8;
  if (hoursAgo <= 72) return 6;
  if (hoursAgo <= 168) return 3; // 1 week
  return 1;
}

/**
 * Compute the snooze penalty (0 to -15).
 * Tasks that are actively snoozed get pushed down in the score ranking.
 */
function computeSnoozePenalty(snoozedUntil: string | null | undefined): number {
  if (!snoozedUntil) return 0;
  const now = new Date();
  const until = new Date(snoozedUntil);
  if (until.getTime() <= now.getTime()) return 0; // snooze expired
  return -15;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function createScoreInput(
  task: ScoreInputTask,
  tags: Iterable<string | { id: string; name: string }> = [],
  projects: Iterable<string | { id: string; name: string }> = [],
): ScoreInput {
  const tagRecords = Array.from(tags);
  const projectRecords = Array.from(projects);
  const names = (records: Array<string | { id: string; name: string }>) =>
    records.map((record) => typeof record === 'string' ? record : record.name);

  return {
    taskId: task.id,
    title: task.title,
    priority: task.priority,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    connectorType: task.connectorType,
    connectorInstanceId: task.connectorInstanceId,
    linkedEntityNames: [
      ...names(tagRecords),
      ...names(projectRecords),
      task.sourceListName,
      task.assignee,
    ].filter((name): name is string => Boolean(name)),
    personText: [
      task.title,
      task.description,
      task.assignee,
    ].filter((text): text is string => Boolean(text)),
    linkedEntityRefs: [
      ...tagRecords.flatMap((record) => typeof record === 'string' ? [] : [{ type: 'tag' as const, id: record.id }]),
      ...projectRecords.flatMap((record) => typeof record === 'string' ? [] : [{ type: 'project' as const, id: record.id }]),
      ...(task.sourceListId
        ? [{ type: 'source' as const, id: `${task.connectorInstanceId}:${task.sourceListId}` }]
        : []),
    ],
    snoozedUntil: task.snoozedUntil,
    effort: task.effort,
  };
}

/**
 * Compute the smart score for a single task.
 */
export function computeSmartScore(
  input: ScoreInput,
  entities: PriorityEntity[],
  rankings: SourceRanking[],
): ScoredTask {
  const priorityBase = computePriorityBase(input.priority);
  const { score: entityTier, matched } = computeEntityScore(
    input.linkedEntityNames,
    input.personText,
    input.linkedEntityRefs,
    entities,
  );
  const urgency = computeUrgencyScore(input.dueDate, input.priority);
  const sourceRank = computeSourceScore(input.connectorInstanceId, rankings);
  const freshness = computeFreshnessScore(input.updatedAt);
  const effortBonus = input.effort ? (EFFORT_BONUS[input.effort] ?? 0) : 0;
  const snoozePenalty = computeSnoozePenalty(input.snoozedUntil);

  const raw = priorityBase + entityTier + urgency + sourceRank + freshness + effortBonus + snoozePenalty;
  const total = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));

  return {
    taskId: input.taskId,
    score: { priorityBase, entityTier, urgency, sourceRank, freshness, effortBonus, snoozePenalty, total },
    matchedEntities: matched,
  };
}

/**
 * Compute smart scores for a batch of tasks and return sorted by score (descending).
 */
export function computeBatchSmartScores(
  tasks: ScoreInput[],
  entities: PriorityEntity[],
  rankings: SourceRanking[],
): ScoredTask[] {
  return tasks
    .map((task) => computeSmartScore(task, entities, rankings))
    .sort((a, b) => b.score.total - a.score.total);
}

/**
 * Get the score tier label for UI display.
 */
export function getScoreTier(score: number): 'high' | 'mid' | 'low' {
  if (score >= 75) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}

/**
 * Default weights configuration (stored in smartScoreSettings table).
 */
export const DEFAULT_SCORE_WEIGHTS = {
  priorityBase: 20,
  entityTier: 30,
  urgency: 25,
  sourceRank: 12,
  freshness: 13,
};
