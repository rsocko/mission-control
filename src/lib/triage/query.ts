/**
 * Action-path triage lookup. The portable queue list/filter surface lives in
 * `queue-query.ts`; this module keeps the single-item read the action routes
 * need, now served by the composed triage persistence repositories so the
 * action routes no longer evaluate SQLite at import time.
 */
import type { TriageItem } from '@/types';
import { ensureSeedData } from './shared';
import { getTriagePersistenceRepositories } from './persistence';

export {
  isValidTriageSource,
  isValidTriageStatus,
  listTriageItems,
  type TriageFilters,
  type TriageSortBy,
} from './queue-query';

export async function getTriageItemById(id: string): Promise<TriageItem | null> {
  await ensureSeedData();
  return getTriagePersistenceRepositories().items.get(id);
}
