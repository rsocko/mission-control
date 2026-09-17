import { describe, expect, it } from 'vitest';
import {
  VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeList,
} from '@/lib/ui/list-virtualization';

describe('list virtualization threshold', () => {
  it('keeps lists at or below 50 items in the normal document flow', () => {
    expect(VIRTUALIZATION_THRESHOLD).toBe(50);
    expect(shouldVirtualizeList(0)).toBe(false);
    expect(shouldVirtualizeList(50)).toBe(false);
  });

  it('virtualizes lists above 50 items', () => {
    expect(shouldVirtualizeList(51)).toBe(true);
    expect(shouldVirtualizeList(400)).toBe(true);
  });
});
