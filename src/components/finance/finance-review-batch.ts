import type { AttributionException } from './types';
import { normalizeAttributionMerchant } from '@/lib/finance/attribution-merchant';

export const MAX_GROUPED_SELECTION = 100;
export const GROUPED_ASSIGNMENT_CONCURRENCY = 4;

export interface AttributionMerchantGroup {
  key: string;
  merchantName: string;
  exceptions: AttributionException[];
}

export function groupAttributionExceptions(
  exceptions: AttributionException[],
): AttributionMerchantGroup[] {
  const groups = new Map<string, AttributionMerchantGroup>();
  for (const exception of exceptions) {
    const key = normalizeAttributionMerchant(exception.merchantName);
    const existing = groups.get(key);
    if (existing) {
      existing.exceptions.push(exception);
    } else {
      groups.set(key, {
        key,
        merchantName: key,
        exceptions: [exception],
      });
    }
  }
  return [...groups.values()];
}

export async function runWithBoundedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
  return results;
}
