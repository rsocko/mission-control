import { NextRequest, NextResponse } from 'next/server';
import { computeInsights, getSourceBreakdown, type InsightsPeriod } from '@/lib/stats/insights';
import { getInclusivePeriodBoundaries } from '@/lib/stats/delivery';
import {
  detectObservations,
  generateLLMObservations,
  type AIObservation,
} from '@/lib/stats/observations';

export type { AIObservation };

// ─── LLM Observation Cache ──────────────────────────────────────────────────

interface CachedResult {
  observations: AIObservation[];
  generatedAt: string;
  expiresAt: number;
}

const LLM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const llmCache = new Map<number, CachedResult>();

function getCachedLLM(period: number): CachedResult | null {
  const entry = llmCache.get(period);
  if (entry && Date.now() < entry.expiresAt) return entry;
  if (entry) llmCache.delete(period);
  return null;
}

function setCachedLLM(period: number, observations: AIObservation[]): void {
  // Bound cache size (max 3 entries: one per valid period)
  if (llmCache.size >= 3) {
    const oldestKey = llmCache.keys().next().value;
    if (oldestKey !== undefined) llmCache.delete(oldestKey);
  }
  llmCache.set(period, {
    observations,
    generatedAt: new Date().toISOString(),
    expiresAt: Date.now() + LLM_CACHE_TTL_MS,
  });
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * AI Observations endpoint.
 * Accepts ?period=7|30|90 (default 30).
 * Runs deterministic pattern detectors on real data, then optionally
 * enriches with LLM-generated observations if AI is configured.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const periodParam = Number(searchParams.get('period') || 30);
    const period: InsightsPeriod = ([7, 30, 90] as const).includes(periodParam as InsightsPeriod)
      ? (periodParam as InsightsPeriod)
      : 30;

    const snapshot = await computeInsights(period, { includeFlow: false });

    // Compute previous-period source breakdown for balance shift detection
    const {
      previousPeriodStart,
      previousPeriodEnd,
    } = getInclusivePeriodBoundaries(snapshot.periodEnd, period);
    const previousSourceBreakdown = await getSourceBreakdown(previousPeriodStart, previousPeriodEnd);

    // Run deterministic detectors
    const ruleObservations = detectObservations({
      snapshot,
      previousSourceBreakdown,
    });

    // Attempt LLM enrichment with caching
    let llmObservations: AIObservation[] = [];
    if (ruleObservations.length < 3) {
      const cached = getCachedLLM(period);
      if (cached) {
        llmObservations = cached.observations;
      } else {
        llmObservations = await generateLLMObservations(snapshot);
        if (llmObservations.length > 0) {
          setCachedLLM(period, llmObservations);
        }
      }
    }

    // Merge: rule-based take priority, fill remaining slots with LLM
    const combined = [...ruleObservations];
    for (const obs of llmObservations) {
      if (combined.length >= 3) break;
      if (!combined.find(existing => existing.type === obs.type)) {
        combined.push(obs);
      }
    }

    return NextResponse.json({
      observations: combined,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[observations] Error generating observations:', error);
    return NextResponse.json(
      { observations: [], generatedAt: new Date().toISOString(), error: 'Failed to compute observations' },
      { status: 500 },
    );
  }
}
