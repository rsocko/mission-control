/**
 * Legacy action-path lookup. The portable queue list/filter surface lives in
 * `queue-query.ts`; this module deliberately retains the action routes' existing
 * SQLite ownership until their excluded AI and external-action dependencies are
 * migrated together.
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ensureSeedData, mapRow } from './shared';

export {
  isValidTriageSource,
  isValidTriageStatus,
  listTriageItems,
  type TriageFilters,
  type TriageSortBy,
} from './queue-query';

export async function getTriageItemById(id: string): Promise<TriageItem | null> {
  await ensureSeedData();
  const [row] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  return row ? mapRow(row) : null;
}
