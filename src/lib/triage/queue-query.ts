import type { TriageSourcePlatform, TriageStatus } from '@/types';
import type {
  TriageQueueListFilters,
  TriageQueueSortBy,
} from '@/db/persistence/triage-repositories';
import { getTriagePersistenceRepositories } from './persistence';
import { ensureSeedData } from './shared';

export type TriageSortBy = TriageQueueSortBy;
export type TriageFilters = TriageQueueListFilters;

const ALLOWED_STATUSES = new Set<TriageStatus | 'all'>([
  'all',
  'pending',
  'snoozed',
  'actioned',
  'dismissed',
]);
const ALLOWED_SOURCES = new Set<TriageSourcePlatform | 'all'>([
  'all',
  'reddit',
  'youtube',
  'instagram',
  'facebook',
  'github',
  'twitter',
  'tiktok',
  'pinterest',
  'document-intelligence',
  'scout',
  'ios_share',
  'android_share',
  'browser_extension',
  'browser_tabs',
  'web',
]);

export async function listTriageItems(filters: TriageFilters = {}) {
  await ensureSeedData();
  return getTriagePersistenceRepositories().items.list(filters);
}

export function isValidTriageStatus(value: string | null): value is TriageStatus | 'all' {
  return !!value && ALLOWED_STATUSES.has(value as TriageStatus | 'all');
}

export function isValidTriageSource(
  value: string | null,
): value is TriageSourcePlatform | 'all' {
  return !!value && ALLOWED_SOURCES.has(value as TriageSourcePlatform | 'all');
}
