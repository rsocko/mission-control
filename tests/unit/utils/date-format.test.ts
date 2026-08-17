import { describe, expect, it } from 'vitest';
import { parseLocalDate } from '@/lib/utils/date-format';

describe('parseLocalDate', () => {
  it('preserves date-only calendar fields in local time', () => {
    const parsed = parseLocalDate('2026-10-01');

    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(1);
  });
});
