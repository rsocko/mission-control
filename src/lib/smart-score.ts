/**
 * Smart Score Engine
 *
 * Computes a composite 0–100 score for each task by combining:
 *   - Task priority (up to 25 pts)
 *   - Planning horizon (up to 20 pts)
 *   - Urgency / due-date pressure (up to 20 pts)
 *   - Organizational context (up to 20 pts)
 *   - Typed momentum and commitment signals (up to 10 pts)
 *   - Source trust rank (up to 5 pts)
 *
 * Duration and effort are audited for contextual planning, but intentionally do
 * not change Smart Score. They describe session fit rather than importance.
 */

import type { PlanningHorizon, TaskPriority, TaskStatus } from '@/types';

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
  status: TaskStatus | string;
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
  /** Effort level 1–5 (optional). Audited for contextual planning only. */
  effort?: number | null;
  /** Broad planning intent, independent of a concrete due date. */
  planningHorizon?: PlanningHorizon | null;
  /** Estimated task duration in minutes. Audited for contextual planning only. */
  estimatedDuration?: number | null;
  momentum?: ScoreMomentumInput;
}

export interface ScoreInputTask {
  id: string;
  title: string;
  status?: TaskStatus | string;
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
  planningHorizon?: PlanningHorizon | null;
  estimatedDuration?: number | null;
}

export interface ScoreMomentumInput {
  currentDate: string;
  latestMyDayDate?: string | null;
  latestMyDayAddedAt?: string | null;
  lastMyDayCommittedAt?: string | null;
  lastMyDayWithdrawnAt?: string | null;
  inProgressStartedAt?: string | null;
  lastSubtaskCompletedAt?: string | null;
}

export type ScoreConfidenceLevel = 'high' | 'medium' | 'low';

export interface ScoreAuditEvidence {
  factor: 'priority' | 'planningHorizon' | 'urgency' | 'organizationalContext'
    | 'momentum' | 'sourceTrust' | 'snooze';
  label: string;
  detail: string;
  points: number;
  occurredAt?: string | null;
}

export interface ScoreAudit {
  confidence: {
    level: ScoreConfidenceLevel;
    percentage: number;
  };
  evidence: ScoreAuditEvidence[];
  missingSignals: string[];
  sessionFit: {
    estimatedDuration: number | null;
    effort: number | null;
    status: string;
    note: string;
  };
}

export interface ScoreBreakdown {
  priority: number; // 0–25
  organizationalContext: number; // 0–20
  urgency: number;      // 0–20
  planningHorizon: number; // 0–20
  momentum: number; // 0–10
  sourceTrust: number; // 0–5
  snoozePenalty: number; // 0 to -15 (penalty applied when task is snoozed)
  total: number;        // 0–100
  audit: ScoreAudit;
}

export interface ScoredTask {
  taskId: string;
  score: ScoreBreakdown;
  matchedEntities: Array<{ name: string; tier: EntityTier; rank: number }>;
}

// ─── Scoring Weights ────────────────────────────────────────────────────────

const TIER_POINTS: Record<EntityTier, number> = {
  critical: 20,
  high: 14,
  medium: 8,
  standard: 2,
};

/** Points awarded from the task's explicit priority level (0–25). */
const PRIORITY_BASE_POINTS: Record<TaskPriority, number> = {
  critical: 25,
  high: 19,
  medium: 11,
  low: 4,
  none: 0,
};

const PLANNING_HORIZON_POINTS: Record<PlanningHorizon, number> = {
  next: 20,
  soon: 14,
  later: 6,
  someday: 0,
};

export const SMART_SCORE_FACTOR_MAX = {
  priority: 25,
  organizationalContext: 20,
  urgency: 20,
  planningHorizon: 20,
  momentum: 10,
  sourceTrust: 5,
  snoozePenalty: 15,
} as const;

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
 * Compute the organizational-context component (0–20).
 * Uses the best-matched entity tier for this task.
 */
function computeEntityScore(
  linkedNames: string[],
  personText: string[],
  linkedRefs: ScoreInput['linkedEntityRefs'],
  entities: PriorityEntity[],
): {
  score: number;
  matched: Array<{ name: string; tier: EntityTier; rank: number }>;
  strongest: { name: string; tier: EntityTier; rank: number } | null;
} {
  if (
    entities.length === 0
    || (linkedNames.length === 0 && personText.length === 0 && linkedRefs.length === 0)
  ) {
    return { score: 0, matched: [], strongest: null };
  }

  const matched: Array<{ name: string; tier: EntityTier; rank: number }> = [];
  let bestScore = 0;
  let strongest: { name: string; tier: EntityTier; rank: number } | null = null;

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
      const rankBonus = Math.max(0, (20 - entity.rank) * 0.25);
      const entityScore = Math.min(
        SMART_SCORE_FACTOR_MAX.organizationalContext,
        tierScore + rankBonus,
      );

      matched.push({ name: entity.name, tier: entity.tier, rank: entity.rank });
      if (entityScore > bestScore) {
        bestScore = entityScore;
        strongest = { name: entity.name, tier: entity.tier, rank: entity.rank };
      }
    }
  }

  return { score: Math.round(bestScore), matched, strongest };
}

/**
 * Compute the task-priority component (0–25).
 * Ensures higher-priority tasks get a significant score floor.
 */
function computePriorityBase(priority: TaskPriority): number {
  return PRIORITY_BASE_POINTS[priority] ?? 0;
}

/**
 * Compute the urgency component (0–20) from due-date pressure.
 * Priority is scored separately so it is not counted twice.
 */
function computeUrgencyScore(dueDate: string | null | undefined): number {
  if (!dueDate) return 0;

  // Date-only deadlines remain due through the end of their calendar day.
  const dueTime = /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
    ? new Date(`${dueDate}T23:59:59.999`).getTime()
    : new Date(dueDate).getTime();
  const daysUntilDue = (dueTime - Date.now()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(daysUntilDue)) return 0;
  if (daysUntilDue < 0) return 20;
  if (daysUntilDue <= 1) return 18;
  if (daysUntilDue <= 3) return 15;
  if (daysUntilDue <= 7) return 11;
  if (daysUntilDue <= 14) return 7;
  return 2;
}

/**
 * Compute the source-trust component (0–5).
 * Higher-ranked sources produce higher scores.
 */
function computeSourceScore(connectorInstanceId: string, sourceRankings: SourceRanking[]): number {
  if (sourceRankings.length === 0) return 3;

  const ranking = sourceRankings.find((r) => r.id === connectorInstanceId);
  if (!ranking) return 2;

  const totalSources = sourceRankings.length;
  // Rank 1 = 5 pts, last rank = 1 pt.
  const normalized = Math.max(0, 1 - (ranking.rank - 1) / Math.max(1, totalSources - 1));
  return Math.round(1 + normalized * 4);
}

function computePlanningHorizonScore(planningHorizon: PlanningHorizon | null | undefined): number {
  return planningHorizon ? PLANNING_HORIZON_POINTS[planningHorizon] : 0;
}

function ageInDays(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, (Date.now() - value) / 86_400_000);
}

function isAfter(
  candidate: string | null | undefined,
  comparison: string | null | undefined,
): boolean {
  if (!candidate) return false;
  if (!comparison) return true;
  return new Date(candidate).getTime() > new Date(comparison).getTime();
}

function latestTimestamp(
  ...timestamps: Array<string | null | undefined>
): string | null {
  let latest: string | null = null;
  for (const timestamp of timestamps) {
    if (timestamp && isAfter(timestamp, latest)) latest = timestamp;
  }
  return latest;
}

function computeMomentum(
  input: ScoreInput,
): { score: number; evidence: ScoreAuditEvidence[] } {
  const evidence: ScoreAuditEvidence[] = [];
  const momentum = input.momentum;
  if (!momentum) return { score: 0, evidence };

  let commitmentEvidence: ScoreAuditEvidence | null = null;
  if (momentum.latestMyDayDate === momentum.currentDate) {
    commitmentEvidence = {
      factor: 'momentum',
      label: 'Committed to My Day',
      detail: 'This task is in My Day now.',
      points: 6,
      occurredAt: momentum.latestMyDayAddedAt,
    };
  } else if (isAfter(momentum.lastMyDayCommittedAt, momentum.lastMyDayWithdrawnAt)) {
    const days = ageInDays(momentum.lastMyDayCommittedAt);
    const points = days !== null && days <= 1 ? 4
      : days !== null && days <= 3 ? 3
        : days !== null && days <= 7 ? 1
          : 0;
    if (points > 0) {
      commitmentEvidence = {
        factor: 'momentum',
        label: 'Recently committed to My Day',
        detail: 'Recent explicit intent still contributes, with decay.',
        points,
        occurredAt: momentum.lastMyDayCommittedAt,
      };
    }
  }

  let inProgressPoints = 0;
  let latestProgressAt: string | null = null;
  if (input.status === 'in_progress') {
    latestProgressAt = latestTimestamp(
      momentum.inProgressStartedAt,
      momentum.lastSubtaskCompletedAt,
      momentum.lastMyDayCommittedAt,
    );
    const days = ageInDays(latestProgressAt);
    inProgressPoints = days !== null && days <= 2 ? 4
      : days !== null && days <= 7 ? 3
        : days !== null && days <= 30 ? 2
          : 1;
  }

  const subtaskDays = ageInDays(momentum.lastSubtaskCompletedAt);
  const subtaskPoints = subtaskDays !== null && subtaskDays <= 1 ? 4
    : subtaskDays !== null && subtaskDays <= 3 ? 3
      : subtaskDays !== null && subtaskDays <= 7 ? 2
        : subtaskDays !== null && subtaskDays <= 14 ? 1
          : 0;

  const progressPoints = Math.max(inProgressPoints, subtaskPoints);
  if (progressPoints > 0) {
    const hasInProgress = inProgressPoints > 0;
    const hasSubtaskProgress = subtaskPoints > 0;
    evidence.push({
      factor: 'momentum',
      label: hasInProgress && hasSubtaskProgress
        ? 'Work underway'
        : hasSubtaskProgress
          ? 'Subtask completed'
          : 'Work started',
      detail: hasInProgress && hasSubtaskProgress
        ? 'The task is in progress with recent concrete subtask progress.'
        : hasSubtaskProgress
          ? 'Recent concrete progress increases momentum.'
          : latestProgressAt
            ? 'In-progress intent remains relevant and decays without typed activity.'
            : 'The task is in progress; its start time is unavailable.',
      points: progressPoints,
      occurredAt: latestTimestamp(latestProgressAt, momentum.lastSubtaskCompletedAt),
    });
  }

  const createdDays = ageInDays(input.createdAt);
  const creationPoints = createdDays !== null && createdDays <= 2 ? 2
    : createdDays !== null && createdDays <= 7 ? 1
      : 0;
  if (commitmentEvidence) evidence.unshift(commitmentEvidence);
  const remainingForCreation = Math.max(
    0,
    SMART_SCORE_FACTOR_MAX.momentum
    - evidence.reduce((total, item) => total + item.points, 0),
  );
  if (creationPoints > 0 && remainingForCreation > 0) {
    evidence.push({
      factor: 'momentum',
      label: 'Recently created',
      detail: 'New work receives a small, temporary discovery boost.',
      points: Math.min(creationPoints, remainingForCreation),
      occurredAt: input.createdAt,
    });
  }

  return {
    score: evidence.reduce((total, item) => total + item.points, 0),
    evidence,
  };
}

/**
 * Compute the snooze penalty (0 to -15).
 * Tasks that are actively snoozed get pushed down in the score ranking.
 */
function computeSnoozePenalty(snoozedUntil: string | null | undefined): number {
  if (!snoozedUntil) return 0;
  const until = new Date(snoozedUntil).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) return 0;
  return -15;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function createScoreInput(
  task: ScoreInputTask,
  tags: Iterable<string | { id: string; name: string }> = [],
  projects: Iterable<string | { id: string; name: string }> = [],
  momentum?: ScoreMomentumInput,
): ScoreInput {
  const tagRecords = Array.from(tags);
  const projectRecords = Array.from(projects);
  const names = (records: Array<string | { id: string; name: string }>) =>
    records.map((record) => typeof record === 'string' ? record : record.name);

  return {
    taskId: task.id,
    title: task.title,
    status: task.status ?? 'todo',
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
    planningHorizon: task.planningHorizon,
    estimatedDuration: task.estimatedDuration,
    momentum,
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
  const priority = computePriorityBase(input.priority);
  const { score: organizationalContext, matched, strongest } = computeEntityScore(
    input.linkedEntityNames,
    input.personText,
    input.linkedEntityRefs,
    entities,
  );
  const urgency = computeUrgencyScore(input.dueDate);
  const planningHorizon = computePlanningHorizonScore(input.planningHorizon);
  const sourceTrust = computeSourceScore(input.connectorInstanceId, rankings);
  const momentumResult = computeMomentum(input);
  const snoozePenalty = computeSnoozePenalty(input.snoozedUntil);

  const raw = priority
    + organizationalContext
    + urgency
    + planningHorizon
    + sourceTrust
    + momentumResult.score
    + snoozePenalty;
  const total = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
  const ranking = rankings.find((item) => item.id === input.connectorInstanceId);
  const evidence: ScoreAuditEvidence[] = [
    {
      factor: 'priority',
      label: 'Task priority',
      detail: input.priority === 'none' ? 'No explicit priority is set.' : `${input.priority} priority`,
      points: priority,
    },
    {
      factor: 'planningHorizon',
      label: 'Planning horizon',
      detail: input.planningHorizon
        ? `${input.planningHorizon} planning intent`
        : 'No planning horizon is set.',
      points: planningHorizon,
    },
    {
      factor: 'urgency',
      label: 'Due-date urgency',
      detail: input.dueDate ? `Due ${input.dueDate}` : 'No due date pressure.',
      points: urgency,
      occurredAt: input.dueDate,
    },
    {
      factor: 'organizationalContext',
      label: 'Organizational context',
      detail: strongest
        ? `${strongest.name} is a ${strongest.tier} priority entity.`
        : 'No prioritized project, list, tag, or person matched.',
      points: organizationalContext,
    },
    {
      factor: 'sourceTrust',
      label: 'Source trust',
      detail: ranking
        ? `${ranking.name} is ranked ${ranking.rank} of ${rankings.length}.`
        : rankings.length === 0
          ? 'Source rankings are not configured; neutral credit applied.'
          : 'This source is unranked.',
      points: sourceTrust,
    },
    ...momentumResult.evidence,
  ];
  if (snoozePenalty < 0) {
    evidence.push({
      factor: 'snooze',
      label: 'Active snooze',
      detail: `Snoozed until ${input.snoozedUntil}.`,
      points: snoozePenalty,
      occurredAt: input.snoozedUntil,
    });
  }

  const missingSignals = [
    ...(input.priority === 'none' ? ['Task priority is not set'] : []),
    ...(!input.planningHorizon ? ['Planning horizon is not set'] : []),
    ...(matched.length === 0 ? ['No priority entity matches this task'] : []),
    ...(!ranking ? ['Source is not explicitly ranked'] : []),
    ...(!input.momentum ? ['Typed activity audit is unavailable'] : []),
  ];
  const confidencePercentage = Math.min(100,
    (input.priority === 'none' ? 0 : 30)
    + (input.planningHorizon ? 30 : 0)
    + (matched.length > 0 ? 20 : 0)
    + (ranking ? 10 : 0)
    + (input.momentum ? 10 : 0));
  const confidenceLevel: ScoreConfidenceLevel = confidencePercentage >= 75
    ? 'high'
    : confidencePercentage >= 45
      ? 'medium'
      : 'low';

  return {
    taskId: input.taskId,
    score: {
      priority,
      organizationalContext,
      urgency,
      planningHorizon,
      momentum: momentumResult.score,
      sourceTrust,
      snoozePenalty,
      total,
      audit: {
        confidence: {
          level: confidenceLevel,
          percentage: confidencePercentage,
        },
        evidence,
        missingSignals,
        sessionFit: {
          estimatedDuration: input.estimatedDuration ?? null,
          effort: input.effort ?? null,
          status: input.status,
          note: 'Duration and effort inform contextual planning, not Smart Score.',
        },
      },
    },
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
  priority: SMART_SCORE_FACTOR_MAX.priority,
  organizationalContext: SMART_SCORE_FACTOR_MAX.organizationalContext,
  urgency: SMART_SCORE_FACTOR_MAX.urgency,
  planningHorizon: SMART_SCORE_FACTOR_MAX.planningHorizon,
  momentum: SMART_SCORE_FACTOR_MAX.momentum,
  sourceTrust: SMART_SCORE_FACTOR_MAX.sourceTrust,
};
