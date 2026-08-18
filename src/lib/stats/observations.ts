/**
 * AI Observations Engine — deterministic pattern detectors + LLM summarization
 *
 * Analyzes InsightsSnapshot data to produce actionable observation cards.
 * Two layers:
 *   1. Rule-based detectors (always run, no external deps)
 *   2. LLM-powered natural language summaries (optional, requires AI config)
 */

import type { InsightsSnapshot, TrendDataPoint, SourceBreakdownItem } from './insights';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AIObservation {
  id: string;
  type: 'pattern' | 'stale' | 'balance' | 'streak' | 'workload';
  title: string;
  description: string;
  severity?: 'info' | 'warning' | 'positive';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00').getDay();
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Deterministic Detectors ────────────────────────────────────────────────

/**
 * Detect day-of-week productivity patterns.
 * Finds if any day has 40%+ more completions than the average.
 */
function detectDayOfWeekPattern(trends: TrendDataPoint[]): AIObservation | null {
  if (trends.length < 7) return null;

  const dayTotals = new Array(7).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const point of trends) {
    const dow = getDayOfWeek(point.date);
    dayTotals[dow] += point.completed;
    dayCounts[dow]++;
  }

  const dayAverages = dayTotals.map((total, i) => dayCounts[i] > 0 ? total / dayCounts[i] : 0);
  const overallAvg = dayAverages.reduce((sum, v) => sum + v, 0) / 7;

  if (overallAvg === 0) return null;

  let bestDay = 0;
  let bestAvg = 0;
  for (let i = 0; i < 7; i++) {
    if (dayAverages[i] > bestAvg) {
      bestAvg = dayAverages[i];
      bestDay = i;
    }
  }

  const pctAboveAvg = ((bestAvg - overallAvg) / overallAvg) * 100;

  if (pctAboveAvg >= 40) {
    return {
      id: 'obs-dow-pattern',
      type: 'pattern',
      title: `${DAY_NAMES[bestDay]}s are your most productive day`,
      description: `You complete ${Math.round(pctAboveAvg)}% more tasks on ${DAY_NAMES[bestDay]}s than average. Consider scheduling important work then.`,
      severity: 'positive',
    };
  }

  return null;
}

/**
 * Detect stale work — tasks with no movement in 30+ days.
 */
function detectStaleWork(snapshot: InsightsSnapshot): AIObservation | null {
  const staleBuckets = snapshot.taskAge.filter(b => b.minDays >= 31);
  const count = staleBuckets.reduce((sum, b) => sum + b.count, 0);
  if (count === 0) return null;

  return {
    id: 'obs-stale-work',
    type: 'stale',
    title: `${count} task${count === 1 ? '' : 's'} haven't moved in 30+ days`,
    description: count >= 5
      ? 'Consider archiving tasks you won\'t act on, or breaking them into smaller next actions.'
      : 'Review these items — they may need a nudge or should be archived.',
    severity: 'warning',
  };
}

/**
 * Detect source balance shifts — any source dropping 40%+ period-over-period.
 * Uses the KPI deltas to infer shifts in connector completion ratios.
 */
function detectSourceBalanceShift(
  currentBreakdown: SourceBreakdownItem[],
  previousBreakdown: SourceBreakdownItem[],
): AIObservation | null {
  if (currentBreakdown.length === 0 || previousBreakdown.length === 0) return null;

  const prevMap = new Map(previousBreakdown.map(s => [s.source, s.count]));
  let biggestDrop: { source: string; dropPct: number } | null = null;

  for (const current of currentBreakdown) {
    const prev = prevMap.get(current.source);
    if (prev && prev > 0) {
      const dropPct = ((prev - current.count) / prev) * 100;
      if (dropPct >= 40 && (!biggestDrop || dropPct > biggestDrop.dropPct)) {
        biggestDrop = { source: current.source, dropPct };
      }
    }
  }

  // Also check sources that disappeared entirely
  for (const [source, prevCount] of prevMap) {
    if (prevCount >= 3 && !currentBreakdown.find(s => s.source === source)) {
      biggestDrop = { source, dropPct: 100 };
      break;
    }
  }

  if (biggestDrop) {
    const label = formatSourceName(biggestDrop.source);
    return {
      id: 'obs-source-balance',
      type: 'balance',
      title: `${label} completions dropped ${Math.round(biggestDrop.dropPct)}%`,
      description: `Your ${label} task completions declined significantly compared to last period. Check if blockers or context-switching are factors.`,
      severity: 'warning',
    };
  }

  return null;
}

/**
 * Detect routine compliance trends — declining streak.
 */
function detectStreakDecline(snapshot: InsightsSnapshot): AIObservation | null {
  const streakKpi = snapshot.kpis.streak;
  if (streakKpi.value === 0 && streakKpi.previousValue != null && streakKpi.previousValue >= 5) {
    return {
      id: 'obs-streak-broken',
      type: 'streak',
      title: 'Your completion streak reset',
      description: `You had a ${streakKpi.previousValue}-day streak going. Start fresh today — even one task completed counts.`,
      severity: 'info',
    };
  }

  if (streakKpi.value >= 7) {
    return {
      id: 'obs-streak-strong',
      type: 'streak',
      title: `${streakKpi.value}-day completion streak`,
      description: 'You\'ve completed at least one task every day. Keep the momentum going!',
      severity: 'positive',
    };
  }

  return null;
}

/**
 * Detect workload imbalance — created >> completed trending.
 */
function detectWorkloadImbalance(snapshot: InsightsSnapshot): AIObservation | null {
  const { created, completed } = snapshot.kpis;

  if (created.value === 0 && completed.value === 0) return null;

  const ratio = created.value / Math.max(completed.value, 1);

  if (ratio >= 2 && created.value >= 4) {
    return {
      id: 'obs-workload-imbalance',
      type: 'workload',
      title: 'Backlog is growing rapidly',
      description: `You created ${created.value} tasks but only completed ${completed.value} this period. Consider pausing intake or doing a triage pass.`,
      severity: 'warning',
    };
  }

  if (completed.value > created.value * 1.5 && completed.value >= 5) {
    return {
      id: 'obs-workload-shrinking',
      type: 'workload',
      title: 'You\'re reducing your backlog',
      description: `Completed ${completed.value} vs ${created.value} created — your backlog is shrinking. Great progress.`,
      severity: 'positive',
    };
  }

  return null;
}

function detectPlanningFriction(snapshot: InsightsSnapshot): AIObservation | null {
  const friction = snapshot.planningFriction;
  if (friction.pushesInPeriod < 3) return null;

  const strongestPattern = friction.topTags[0] ?? friction.topLists[0];
  const patternHint = strongestPattern
    ? ` ${strongestPattern.label.slice(0, 40)} appears most often; consider smaller milestones there.`
    : ' Consider smaller milestones or more realistic first dates for the most-shifted work.';

  return {
    id: 'obs-planning-friction',
    type: 'pattern',
    title: `Plans shifted ${friction.pushesInPeriod} times`,
    description: `${friction.pushedTaskCount} tasks moved a total of ${friction.totalDaysDeferred} days.${patternHint}`,
    severity: 'warning',
  };
}

// ─── Source name formatting ─────────────────────────────────────────────────

function formatSourceName(source: string): string {
  const names: Record<string, string> = {
    microsoft_todo: 'Microsoft Todo',
    github: 'GitHub',
    outlook: 'Outlook',
    calendar: 'Calendar',
    manual: 'Manual',
    rymessage: 'RyMessage',
  };
  return names[source] || source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Main Detection Pipeline ────────────────────────────────────────────────

export interface DetectObservationsOptions {
  snapshot: InsightsSnapshot;
  previousSourceBreakdown?: SourceBreakdownItem[];
}

/**
 * Run all deterministic detectors against the snapshot.
 * Returns up to 3 highest-priority observations.
 */
export function detectObservations(options: DetectObservationsOptions): AIObservation[] {
  const { snapshot, previousSourceBreakdown } = options;
  const results: AIObservation[] = [];

  const dayPattern = detectDayOfWeekPattern(snapshot.trends);
  if (dayPattern) results.push(dayPattern);

  const planningFriction = detectPlanningFriction(snapshot);
  if (planningFriction) results.push(planningFriction);

  const stale = detectStaleWork(snapshot);
  if (stale) results.push(stale);

  const balance = detectSourceBalanceShift(
    snapshot.sourceBreakdown,
    previousSourceBreakdown ?? [],
  );
  if (balance) results.push(balance);

  const streak = detectStreakDecline(snapshot);
  if (streak) results.push(streak);

  const workload = detectWorkloadImbalance(snapshot);
  if (workload) results.push(workload);

  // Priority: warnings first, then info, then positive. Cap at 3.
  const severityOrder: Record<string, number> = { warning: 0, info: 1, positive: 2 };
  results.sort((a, b) => (severityOrder[a.severity ?? 'info'] ?? 1) - (severityOrder[b.severity ?? 'info'] ?? 1));

  return results.slice(0, 3);
}

// ─── LLM-Powered Observation Generation ─────────────────────────────────────

const OBSERVATIONS_SYSTEM_PROMPT = `You are an AI productivity analyst for a personal task management app called Mission Control. Given analytics data about a user's recent productivity, generate 2-3 concise, actionable observations.

Rules:
- Each observation must be specific and data-backed (reference actual numbers)
- Be encouraging for positive trends, gently direct for negative ones
- Do NOT use gamification language (no "scores", "XP", "levels")
- Keep each title under 50 characters
- Keep each description under 150 characters
- Focus on patterns the user can act on
- Return ONLY valid JSON matching the schema below

Output schema:
{
  "observations": [
    {
      "type": "pattern" | "stale" | "balance" | "streak" | "workload",
      "title": "short title",
      "description": "actionable description"
    }
  ]
}`;

function buildAnalyticsPrompt(snapshot: InsightsSnapshot): string {
  return `Analytics snapshot for the last ${snapshot.period} days (${snapshot.periodStart} to ${snapshot.periodEnd}):

KPIs:
- Completed: ${snapshot.kpis.completed.value} tasks (${snapshot.kpis.completed.delta ?? 0}% vs prior period)
- Created: ${snapshot.kpis.created.value} tasks (${snapshot.kpis.created.delta ?? 0}% vs prior period)
- Net Change: ${snapshot.kpis.netChange.value}
- Avg Task Age: ${snapshot.kpis.avgTaskAge.value} days (${snapshot.kpis.avgTaskAge.delta ?? 0}% change)
- Current Streak: ${snapshot.kpis.streak.value} days

Source Breakdown:
${snapshot.sourceBreakdown.map(s => `- ${formatSourceName(s.source)}: ${s.count} (${s.percentage}%)`).join('\n')}

Task Age Distribution:
${snapshot.taskAge.map(b => `- ${b.label}: ${b.count} tasks`).join('\n')}

Top completion days (last 7):
${snapshot.trends.slice(-7).map(t => `- ${t.date}: ${t.completed} completed, ${t.created} created`).join('\n')}

Generate 2-3 observations about patterns, risks, or positive trends.`;
}

const VALID_OBS_TYPES = new Set(['pattern', 'stale', 'balance', 'streak', 'workload']);

interface LLMObservation {
  type: 'pattern' | 'stale' | 'balance' | 'streak' | 'workload';
  title: string;
  description: string;
}

function isValidLLMObservation(obj: unknown): obj is LLMObservation {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.title === 'string' && o.title.length > 0 &&
    typeof o.description === 'string' && o.description.length > 0 &&
    typeof o.type === 'string' && VALID_OBS_TYPES.has(o.type)
  );
}

/**
 * Generate observations using LLM. Returns empty array if AI is not configured
 * or if the call fails (graceful degradation).
 */
export async function generateLLMObservations(snapshot: InsightsSnapshot): Promise<AIObservation[]> {
  try {
    const { getAIModel } = await import('@/lib/ai/provider-factory');
    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');
    const { generateText } = await import('ai');

    const config = getResolvedAIConfig();
    if (!config.configured) return [];

    const route = getAIModel('stats-observations');

    const result = await generateText({
      model: route.model,
      system: OBSERVATIONS_SYSTEM_PROMPT,
      prompt: buildAnalyticsPrompt(snapshot),
    });

    const text = result.text.trim();
    // Extract JSON from response (handle markdown code fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { observations?: unknown[] };
    if (!Array.isArray(parsed.observations)) return [];

    return parsed.observations
      .filter(isValidLLMObservation)
      .slice(0, 3)
      .map((obs, i) => ({
        id: `obs-llm-${i}`,
        type: obs.type,
        title: String(obs.title).slice(0, 80),
        description: String(obs.description).slice(0, 200),
        severity: 'info' as const,
      }));
  } catch {
    // Graceful degradation — LLM unavailable or errored
    return [];
  }
}
