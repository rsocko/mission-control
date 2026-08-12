import type { DependencyReconciliationProgress } from './task-dependency-manager';

export function getDependencyRelationshipDegradation(
  progress: DependencyReconciliationProgress | undefined,
  staleAfterMs: number,
  now = Date.now(),
): string | null {
  if (progress?.latestTerminalOutcome === 'partial') {
    return 'Latest GitHub relationship poll was partial';
  }
  if ((progress?.consecutiveFailedGenerationCount ?? 0) >= 2) {
    return 'GitHub relationship polling is repeatedly failing';
  }
  const completedAt = progress?.lastCompletedAt
    ? Date.parse(progress.lastCompletedAt)
    : Number.NaN;
  if (!Number.isFinite(completedAt) || now - completedAt > staleAfterMs) {
    return 'GitHub relationship verification is stale';
  }
  return null;
}
