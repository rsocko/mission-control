export const SYNC_ACTIVITY_VERSION = 1 as const;

export type SyncActivityCategory = 'data' | 'attention' | 'work';
export type SyncActivityKind =
  | 'created'
  | 'updated'
  | 'removed'
  | 'resolved'
  | 'processed'
  | 'snapshot';

export interface SyncActivityMetric {
  key: string;
  label: string;
  value: number;
  kind: SyncActivityKind;
}

export interface SyncActivityGroup {
  key: string;
  label: string;
  category: SyncActivityCategory;
  metrics: SyncActivityMetric[];
}

export interface SyncActivityPayload {
  version: typeof SYNC_ACTIVITY_VERSION;
  status?: 'complete' | 'partial';
  groups: SyncActivityGroup[];
}

const categories = new Set<SyncActivityCategory>(['data', 'attention', 'work']);
const kinds = new Set<SyncActivityKind>([
  'created',
  'updated',
  'removed',
  'resolved',
  'processed',
  'snapshot',
]);

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function normalizeSyncActivity(value: unknown): SyncActivityPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { version?: unknown; status?: unknown; groups?: unknown };
  if (
    candidate.version !== SYNC_ACTIVITY_VERSION
    || (candidate.status !== undefined
      && candidate.status !== 'complete'
      && candidate.status !== 'partial')
    || !Array.isArray(candidate.groups)
    || candidate.groups.length > 12
  ) {
    return null;
  }

  const groupKeys = new Set<string>();
  const groups: SyncActivityGroup[] = [];
  for (const rawGroup of candidate.groups) {
    if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) return null;
    const group = rawGroup as {
      key?: unknown;
      label?: unknown;
      category?: unknown;
      metrics?: unknown;
    };
    if (
      !boundedText(group.key, 80)
      || groupKeys.has(group.key)
      || !boundedText(group.label, 120)
      || !categories.has(group.category as SyncActivityCategory)
      || !Array.isArray(group.metrics)
      || group.metrics.length > 20
    ) {
      return null;
    }

    const metricKeys = new Set<string>();
    const metrics: SyncActivityMetric[] = [];
    for (const rawMetric of group.metrics) {
      if (!rawMetric || typeof rawMetric !== 'object' || Array.isArray(rawMetric)) return null;
      const metric = rawMetric as {
        key?: unknown;
        label?: unknown;
        value?: unknown;
        kind?: unknown;
      };
      if (
        !boundedText(metric.key, 80)
        || metricKeys.has(metric.key)
        || !boundedText(metric.label, 120)
        || !Number.isSafeInteger(metric.value)
        || (metric.value as number) < 0
        || !kinds.has(metric.kind as SyncActivityKind)
      ) {
        return null;
      }
      metricKeys.add(metric.key);
      metrics.push({
        key: metric.key,
        label: metric.label,
        value: metric.value as number,
        kind: metric.kind as SyncActivityKind,
      });
    }

    groupKeys.add(group.key);
    groups.push({
      key: group.key,
      label: group.label,
      category: group.category as SyncActivityCategory,
      metrics,
    });
  }

  return {
    version: SYNC_ACTIVITY_VERSION,
    ...(candidate.status ? { status: candidate.status as 'complete' | 'partial' } : {}),
    groups,
  };
}

export function hasSyncActivity(value: unknown): boolean {
  const activity = normalizeSyncActivity(value);
  return activity?.groups.some(group => group.metrics.some(
    metric => metric.kind !== 'snapshot' && metric.value > 0,
  )) ?? false;
}

export function mergeSyncActivity(
  ...payloads: Array<SyncActivityPayload | null | undefined>
): SyncActivityPayload | undefined {
  const groups = payloads.flatMap(payload => payload?.groups ?? []);
  if (groups.length === 0) return undefined;
  return {
    version: SYNC_ACTIVITY_VERSION,
    status: payloads.some(payload => payload?.status === 'partial') ? 'partial' : 'complete',
    groups,
  };
}
