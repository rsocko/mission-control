/**
 * Triage Auto-Sync Agent
 *
 * Orchestrates all configured triage source syncs with:
 * - Per-source configurable intervals
 * - Last-run timestamp tracking
 * - Health monitoring with exponential backoff on errors
 * - Aggregate sync results across all sources
 * - Simple lock to prevent concurrent runs
 */
import logger from '@/lib/logger';
import { triageSyncScheduler, type TriageSourceId } from './scheduler';
import { getAllSyncStates, type TriageSyncStateRecord } from './sync-state';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SourceSyncResult {
  sourceId: TriageSourceId;
  success: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  durationMs: number;
  backoffUntil?: string;
}

export interface AggregateSyncResult {
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  sources: SourceSyncResult[];
  totalImported: number;
  totalSkipped: number;
  totalErrors: number;
}

export interface SourceHealthState {
  sourceId: TriageSourceId;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  backoffUntil: string | null;
}

// ─── State ──────────────────────────────────────────────────────────────────

const healthStates = new Map<TriageSourceId, SourceHealthState>();
let syncLock = false;

const DEFAULT_INTERVALS: Record<TriageSourceId, number> = {
  'reddit-saved': 15,
  'github-stars': 30,
  'youtube': 30,
  'document-intelligence': 15,
};

const MAX_BACKOFF_MINUTES = 120;
const BASE_BACKOFF_MINUTES = 5;

// ─── Health Tracking ────────────────────────────────────────────────────────

function getHealthState(sourceId: TriageSourceId): SourceHealthState {
  if (!healthStates.has(sourceId)) {
    healthStates.set(sourceId, {
      sourceId,
      consecutiveFailures: 0,
      lastFailureAt: null,
      backoffUntil: null,
    });
  }
  return healthStates.get(sourceId)!;
}

function recordSuccess(sourceId: TriageSourceId): void {
  const state = getHealthState(sourceId);
  state.consecutiveFailures = 0;
  state.lastFailureAt = null;
  state.backoffUntil = null;
}

function recordFailure(sourceId: TriageSourceId): void {
  const state = getHealthState(sourceId);
  state.consecutiveFailures += 1;
  state.lastFailureAt = new Date().toISOString();

  // Exponential backoff: 5min, 10min, 20min, 40min, 80min, 120min (cap)
  const backoffMinutes = Math.min(
    BASE_BACKOFF_MINUTES * Math.pow(2, state.consecutiveFailures - 1),
    MAX_BACKOFF_MINUTES,
  );
  const backoffUntil = new Date(Date.now() + backoffMinutes * 60_000);
  state.backoffUntil = backoffUntil.toISOString();

  logger.warn(
    { sourceId, consecutiveFailures: state.consecutiveFailures, backoffUntil: state.backoffUntil },
    'Source sync failed, applying backoff',
  );
}

function isInBackoff(sourceId: TriageSourceId): boolean {
  const state = getHealthState(sourceId);
  if (!state.backoffUntil) return false;
  return new Date(state.backoffUntil) > new Date();
}

// ─── Sync Orchestration ─────────────────────────────────────────────────────

/**
 * Determines which sources are due for sync based on their configured intervals
 * and last sync timestamps.
 */
export async function getDueSources(): Promise<TriageSourceId[]> {
  const config = await triageSyncScheduler.getConfig();
  const syncStates = await getAllSyncStates();
  const stateMap = new Map(syncStates.map((s) => [s.id, s]));

  const due: TriageSourceId[] = [];
  const now = Date.now();

  for (const [sourceId, sourceConfig] of Object.entries(config.sources)) {
    if (!sourceConfig.enabled) continue;

    const sid = sourceId as TriageSourceId;
    if (isInBackoff(sid)) {
      logger.debug({ sourceId: sid, backoffUntil: getHealthState(sid).backoffUntil }, 'Source in backoff, skipping');
      continue;
    }

    const state = stateMap.get(sourceId);
    if (!state?.lastSyncedAt) {
      // Never synced — it's due
      due.push(sid);
      continue;
    }

    const interval = sourceConfig.intervalMinutes || DEFAULT_INTERVALS[sid] || 30;
    const lastSync = new Date(state.lastSyncedAt).getTime();
    const elapsed = (now - lastSync) / 60_000;

    if (elapsed >= interval) {
      due.push(sid);
    }
  }

  return due;
}

/**
 * Run sync for all due sources. Returns aggregate results.
 * Uses a lock to prevent concurrent runs.
 */
export async function runAllDueSyncs(): Promise<AggregateSyncResult> {
  if (syncLock) {
    logger.warn('Auto-sync agent: sync already in progress, skipping');
    return {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalDurationMs: 0,
      sources: [],
      totalImported: 0,
      totalSkipped: 0,
      totalErrors: 0,
    };
  }

  syncLock = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const results: SourceSyncResult[] = [];

  try {
    const dueSources = await getDueSources();

    if (dueSources.length === 0) {
      logger.debug('Auto-sync agent: no sources due for sync');
    }

    for (const sourceId of dueSources) {
      const sourceStart = Date.now();
      try {
        await triageSyncScheduler.runImport(sourceId);

        // Fetch updated sync state to get import counts
        const syncStates = await getAllSyncStates();
        const state = syncStates.find((s) => s.id === sourceId);

        recordSuccess(sourceId);
        results.push({
          sourceId,
          success: true,
          imported: state?.lastRunImported ?? 0,
          skipped: state?.lastRunSkipped ?? 0,
          errors: [],
          durationMs: Date.now() - sourceStart,
        });
      } catch (err) {
        recordFailure(sourceId);
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          sourceId,
          success: false,
          imported: 0,
          skipped: 0,
          errors: [errorMsg],
          durationMs: Date.now() - sourceStart,
          backoffUntil: getHealthState(sourceId).backoffUntil ?? undefined,
        });
        logger.error({ err, sourceId }, 'Auto-sync agent: source sync failed');
      }
    }
  } finally {
    syncLock = false;
  }

  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    totalDurationMs: Date.now() - startMs,
    sources: results,
    totalImported: results.reduce((sum, r) => sum + r.imported, 0),
    totalSkipped: results.reduce((sum, r) => sum + r.skipped, 0),
    totalErrors: results.filter((r) => !r.success).length,
  };
}

// ─── Health Status ──────────────────────────────────────────────────────────

export function getHealthStatus(): SourceHealthState[] {
  const allSources: TriageSourceId[] = ['github-stars', 'reddit-saved', 'youtube', 'document-intelligence'];
  return allSources.map((sid) => getHealthState(sid));
}

export function getSyncLockStatus(): boolean {
  return syncLock;
}

export { DEFAULT_INTERVALS };
